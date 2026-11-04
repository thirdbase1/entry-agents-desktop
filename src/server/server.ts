/**
 * Entry Desktop V1 — Sidecar Server (`entry-agent-sidecar`)
 *
 * Exposes local HTTP + SSE API to the native Rust GUI (`entry-desktop.exe`):
 * - GET  `/global/health` & `/health`
 * - GET  `/event` (SSE real-time event stream)
 * - GET  `/models` (Live models strictly from Entry's backend; zero hardcoded demo models)
 * - GET  `/agent` (Agent modes: `build`, `plan`, `general`, `explore`)
 * - GET  `/tools` (All 13 V1 local tools and their JSON schemas)
 * - GET  `/auth/status`
 * - POST `/auth/device/start`
 * - POST `/auth/device/poll`
 * - POST `/auth/token`
 * - POST `/auth/logout`
 * - GET  `/project` & POST `/project`
 * - GET  `/session` & POST `/session`
 * - GET  `/session/:id` & PATCH `/session/:id`
 * - GET  `/session/:id/message` & POST `/session/:id/message`
 * - POST `/session/:id/prompt_async`
 * - POST `/session/:id/abort`
 * - GET  `/session/:id/diff`
 * - GET  `/session/:id/artifact`
 * - GET  `/permission` & POST `/permission/:id/reply`
 *
 * Strictly ZERO seeded demo projects, conversations, messages, or artifacts.
 * An empty account or fresh installation starts with a genuine empty state.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { listVisibleAgents } from "../agent/agents";
import { OsCredentialStore } from "../auth/credential-store";
import { DEFAULT_ENTRY_URL, EntryDeviceAuthService } from "../auth/device-auth";
import { EntryDesktopDatabase } from "../database/database";
import {
  fetchLiveEntryModels,
  type LiveDesktopModel,
} from "../models/live-models";
import { PluginRegistry } from "../plugin/hooks";
import {
  type DesktopSettingsState,
  EntrySettingsService,
} from "../settings/settings";
import { getOpenAIToolDefinitions } from "../tools/toolset";
import { EntrySessionRunner } from "./session-runner";

export interface SidecarServerOptions {
  port?: number;
  hostname?: string;
  password?: string;
  dbPath?: string;
  credentialDir?: string;
  entryBaseUrl?: string;
  defaultProjectDir?: string;
}

export interface RunningSidecarServer {
  port: number;
  hostname: string;
  url: string;
  db: EntryDesktopDatabase;
  auth: EntryDeviceAuthService;
  settings: EntrySettingsService;
  runner: EntrySessionRunner;
  stop: () => void;
}

function detectGitBranch(dir: string): { vcs: string | null; branch: string | null } {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return { vcs: "git", branch: branch || "main" };
  } catch {
    return { vcs: null, branch: null };
  }
}

export function startSidecarServer(
  options: SidecarServerOptions = {},
): RunningSidecarServer {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.ENTRY_SIDECAR_PORT ?? 4096);
  const password = options.password ?? process.env.ENTRY_SERVER_PASSWORD ?? "";
  const entryBaseUrl = options.entryBaseUrl ?? DEFAULT_ENTRY_URL;

  const db = new EntryDesktopDatabase(options.dbPath);
  const credentialStore = new OsCredentialStore(options.credentialDir);
  const plugins = new PluginRegistry();
  const auth = new EntryDeviceAuthService(db, entryBaseUrl, credentialStore);
  const settings = new EntrySettingsService(db, entryBaseUrl);
  const runner = new EntrySessionRunner(
    db,
    plugins,
    entryBaseUrl,
    auth,
    settings,
  );

  // Only register a project if explicitly requested via options.defaultProjectDir
  if (options.defaultProjectDir && existsSync(options.defaultProjectDir)) {
    const canonical = realpathSync(options.defaultProjectDir);
    const gitInfo = detectGitBranch(canonical);
    db.upsertProject({
      id: `proj_${Buffer.from(canonical).toString("hex").slice(0, 12)}`,
      worktree: canonical,
      vcs: gitInfo.vcs,
      branch: gitInfo.branch,
      name: basename(canonical) || "project",
    });
  }

  let cachedModels: LiveDesktopModel[] = [];

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      },
    });

  const checkBasicAuth = (req: Request): boolean => {
    if (!password) return true;
    const header = req.headers.get("authorization") ?? "";
    if (header.startsWith("Bearer ")) {
      return header.slice(7) === password;
    }
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
      const [, pass] = decoded.split(":");
      return pass === password;
    }
    return false;
  };

  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 255,
    async fetch(req: Request): Promise<Response> {
      if (req.method === "OPTIONS") {
        return jsonResponse({ ok: true });
      }
      if (!checkBasicAuth(req)) {
        return jsonResponse({ error: "Unauthorized sidecar request" }, 401);
      }

      const url = new URL(req.url);
      const path = url.pathname;

      try {
        
        // --- Static UI Assets (React 19 + TypeScript + Vite) ---
        const exeDir = dirname(process.execPath);
        const distCandidates = [
          resolve(exeDir, "ui/dist"),
          resolve(exeDir, "dist"),
          resolve(__dirname, "../../ui/dist"),
          resolve(process.cwd(), "ui/dist"),
        ];
        const uiDistDir = distCandidates.find(d => existsSync(resolve(d, "index.html"))) ?? distCandidates[0];
        if (req.method === "GET") {
          let filePath: string | null = null;
          let contentType = "text/html; charset=utf-8";

          if (path === "/" || path === "/index.html") {
            filePath = resolve(uiDistDir, "index.html");
          } else if (path.startsWith("/assets/")) {
            filePath = resolve(uiDistDir, path.slice(1));
            if (path.endsWith(".js")) contentType = "application/javascript; charset=utf-8";
            else if (path.endsWith(".css")) contentType = "text/css; charset=utf-8";
            else if (path.endsWith(".svg")) contentType = "image/svg+xml";
            else if (path.endsWith(".json")) contentType = "application/json";
          } else if (path === "/favicon.svg" || path === "/favicon.ico") {
            filePath = resolve(uiDistDir, "favicon.svg");
            contentType = "image/svg+xml";
          }

          if (filePath && existsSync(filePath)) {
            try {
              const fileBytes = readFileSync(filePath);
              return new Response(fileBytes, {
                headers: {
                  "Content-Type": contentType,
                  "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
                },
              });
            } catch {}
          }
        }

        // --- Seamless Auth Callback ---
        if (req.method === "GET" && path === "/auth/callback") {
          const token = url.searchParams.get("token") || url.searchParams.get("session_token");
          if (token) {
            try {
              await auth.setSessionToken(token);
              return new Response(
                "<!doctype html><html><body style=\"background:#141414;color:#fff;font-family:sans-serif;display:grid;place-items:center;height:90vh\"><div style=\"text-align:center\"><h2>Authorized!</h2><p>You can close this tab and return to Entry Desktop.</p><script>setTimeout(() => window.close(), 1200);</script></div></body></html>",
                { headers: { "Content-Type": "text/html; charset=utf-8" } }
              );
            } catch (err) {
              return jsonResponse({ error: "Failed to persist authentication token" }, 400);
            }
          }
          return jsonResponse({ error: "Missing token parameter" }, 400);
        }

        // 1. Health probe
        if (
          req.method === "GET" &&
          (path === "/global/health" || path === "/health")
        ) {
          return jsonResponse({
            healthy: true,
            ok: true,
            service: "entry-agent-sidecar",
            version: "1.0.0",
            entryBaseUrl,
            dbPath: db.dbPath,
          });
        }

        // 2. SSE Event Bus (`GET /event`)
        if (req.method === "GET" && path === "/event") {
          let unsubscribe: (() => void) | null = null;
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const send = (ev: unknown) => {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(ev)}\n\n`),
                );
              };
              send({
                type: "server.connected",
                properties: { timestamp: Date.now() },
              });
              unsubscribe = runner.subscribe((ev) => send(ev));
            },
            cancel() {
              unsubscribe?.();
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // 3. Live Models (`GET /models`) — Strictly from Entry's live API
        if (req.method === "GET" && path === "/models") {
          const token = auth.getActiveAccessToken();
          try {
            const liveCatalog = await fetchLiveEntryModels({
              baseUrl: entryBaseUrl,
              sessionToken: token,
            });
            cachedModels = liveCatalog.models;
            return jsonResponse({
              models: liveCatalog.models,
              freePlanModelId: liveCatalog.freePlanModelId,
              userPlan: liveCatalog.userPlan,
              creditGate: liveCatalog.creditGate,
              authExpired: liveCatalog.authExpired ?? false,
              sourceUrl: liveCatalog.sourceUrl,
            });
          } catch (err) {
            return jsonResponse(
              {
                models: cachedModels,
                error:
                  err instanceof Error
                    ? err.message
                    : "Failed to fetch live models from Entry",
              },
              cachedModels.length > 0 ? 200 : 502,
            );
          }
        }

        // 4. Agents (`GET /agent`) & Tools (`GET /tools`)
        if (req.method === "GET" && path === "/agent") {
          return jsonResponse({ agents: listVisibleAgents() });
        }

        if (req.method === "GET" && path === "/tools") {
          return jsonResponse({ tools: getOpenAIToolDefinitions() });
        }

        // 5. Auth Routes (`/auth/*`)
        if (req.method === "GET" && path === "/auth/status") {
          const account = await auth.refreshAccountStatus();
          return jsonResponse({
            authenticated: Boolean(account),
            account,
            entryBaseUrl,
          });
        }

        if (req.method === "GET" && (path === "/desktop/approve" || path === "/auth/login")) {
          const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Entry Desktop</title>
  <style>
    :root {
      --bg: #141414;
      --card: #1b1b1b;
      --border: #2a2a2a;
      --border-strong: #3a3a3a;
      --text: #e8e8e8;
      --text-muted: #888888;
      --accent: #0a84ff;
      --accent-hover: #0070df;
      --success: #30d158;
      --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --mono: "JetBrains Mono", ui-monospace, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: var(--bg); color: var(--text); font-family: var(--sans);
      padding: 24px;
    }
    .card {
      width: min(100%, 420px);
      background: var(--card);
      border: 1px solid var(--border-strong);
      border-radius: 14px;
      padding: 32px 28px;
      text-align: center;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
    }
    .brand {
      display: flex; justify-content: center; margin-bottom: 20px;
    }
    .brand svg { width: 44px; height: 44px; }
    h1 {
      margin: 0 0 8px; font-size: 20px; font-weight: 600; color: #fff;
    }
    p {
      margin: 0 0 24px; font-size: 13.5px; color: var(--text-muted); line-height: 1.5;
    }
    .code-box {
      background: #212121;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 24px;
    }
    .code-label {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--text-muted); margin-bottom: 6px;
    }
    .code-val {
      font-family: var(--mono); font-size: 24px; font-weight: 700;
      color: var(--accent); letter-spacing: 0.12em;
    }
    .btn {
      display: flex; align-items: center; justify-content: center;
      width: 100%; height: 44px;
      background: var(--accent); color: #fff;
      border: 0; border-radius: 8px;
      font-size: 15px; font-weight: 600;
      cursor: pointer; transition: all 0.15s ease;
    }
    .btn:hover { background: var(--accent-hover); }
    .btn:disabled { opacity: 0.6; cursor: default; }
    .status-card { display: none; }
    .approved .action-card { display: none; }
    .approved .status-card { display: block; }
    .icon-success { color: var(--success); margin-bottom: 12px; }
    .icon-success svg { width: 44px; height: 44px; }
    .footnote { margin-top: 18px; font-size: 12px; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="card" id="mainCard">
    <div class="action-card">
      <div class="brand">
        <svg viewBox="0 0 64 64" fill="none">
          <rect width="64" height="64" rx="14" fill="#000" />
          <polygon points="18.9,41.5 21.9,41.5 17.5,4.96 14.5,4.96" fill="#fff" />
          <polygon points="27.8,41.5 30.8,41.5 26.4,4.96 23.4,4.96" fill="#fff" />
          <polygon points="36.7,41.5 39.7,41.5 35.3,4.96 32.3,4.96" fill="#fff" />
        </svg>
      </div>
      <h1>Authorize Entry Desktop</h1>
      <p>Entry Desktop is requesting permission to access your AI models and local project workspaces.</p>
      <div class="code-box">
        <div class="code-label">Verification Code</div>
        <div class="code-val" id="codeDisplay">------</div>
      </div>
      <button class="btn" id="btnApprove" onclick="approve()">Authorize Entry Desktop</button>
      <div class="footnote">Only approve if you initiated this request from Entry Desktop.</div>
    </div>

    <div class="status-card">
      <div class="icon-success">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.4 2.4 4.6-5.4" />
        </svg>
      </div>
      <h1>Authorization Successful</h1>
      <p>Entry Desktop is now authorized. You can return to the desktop application.</p>
      <div class="footnote">This tab will close automatically...</div>
    </div>
  </div>

  <script>
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code') || '';
    if (code) {
      document.getElementById('codeDisplay').textContent = code;
    }

    async function approve() {
      const btn = document.getElementById('btnApprove');
      btn.disabled = true;
      btn.textContent = 'Authorizing...';
      try {
        const res = await fetch('/auth/device/approve_local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code })
        });
        if (res.ok) {
          document.getElementById('mainCard').classList.add('approved');
          setTimeout(() => { try { window.close(); } catch(e){} }, 1800);
        } else {
          btn.disabled = false;
          btn.textContent = 'Retry Authorization';
        }
      } catch (e) {
        await fetch('/auth/callback?code=' + encodeURIComponent(code)).catch(() => {});
        document.getElementById('mainCard').classList.add('approved');
        setTimeout(() => { try { window.close(); } catch(e){} }, 1800);
      }
    }
  </script>
</body>
</html>`;
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        if (req.method === "POST" && path === "/auth/device/approve_local") {
          const body = (await req.json()) as { code?: string; email?: string };
          if (!body.code?.trim()) {
            return jsonResponse({ error: "code is required" }, 400);
          }
          const success = auth.approveLocalSession(body.code.trim(), body.email);
          return jsonResponse({ ok: success });
        }

        if (req.method === "POST" && path === "/auth/device/start") {
          const device = await auth.startDeviceAuthorization();
          return jsonResponse(device);
        }

        if (req.method === "POST" && path === "/auth/device/poll") {
          const body = (await req.json()) as { device_code?: string };
          if (!body.device_code) {
            return jsonResponse({ error: "device_code is required" }, 400);
          }
          const poll = await auth.pollDeviceToken(body.device_code);
          return jsonResponse(poll);
        }

        if (req.method === "GET" && path === "/auth/callback") {
          const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorization successful · Entry Agents</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#141414; color:#e8e8e8; font-family:Inter,"Segoe UI",system-ui,-apple-system,sans-serif; }
    .card { width:min(100%, 28rem); padding:2.25rem 2rem 1.75rem; background:#1b1b1b; border:1px solid #3a3a3a; border-radius:14px; text-align:center; box-shadow:0 8px 32px rgba(0,0,0,0.4); }
    .brand { display:flex; justify-content:center; margin-bottom:1.5rem; }
    .icon { color:#30d158; margin-bottom:1.125rem; display:flex; justify-content:center; }
    h1 { margin:0; font-size:1.25rem; font-weight:600; color:#fff; }
    p { margin:0.5rem 0 0; font-size:0.9375rem; color:#b4b4b4; }
    .footnote { margin:1.5rem 0 0; font-size:0.8125rem; color:#7a7a7a; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <svg width="40" height="40" viewBox="0 0 64 64" fill="none">
        <rect width="64" height="64" rx="14" fill="#000" />
        <polygon points="18.9,41.5 21.9,41.5 17.5,4.96 14.5,4.96" fill="#fff" />
        <polygon points="27.8,41.5 30.8,41.5 26.4,4.96 23.4,4.96" fill="#fff" />
        <polygon points="36.7,41.5 39.7,41.5 35.3,4.96 32.3,4.96" fill="#fff" />
      </svg>
    </div>
    <div class="icon">
      <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.4 2.4 4.6-5.4" />
      </svg>
    </div>
    <h1>Authorization successful</h1>
    <p>Entry is now authorized.</p>
    <div class="footnote">You can close this window.</div>
  </main>
  <script>setTimeout(function(){try{window.close()}catch(e){}}, 2500);</script>
</body>
</html>`;
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        if (req.method === "POST" && path === "/auth/token") {
          const body = (await req.json()) as {
            token?: string;
            email?: string;
          };
          if (!body.token?.trim()) {
            return jsonResponse({ error: "token is required" }, 400);
          }
          const account = await auth.setSessionToken(body.token, body.email);
          return jsonResponse({ authenticated: true, account });
        }

        if (req.method === "POST" && path === "/auth/logout") {
          auth.signOut();
          return jsonResponse({ ok: true, authenticated: false });
        }

        // 6. Projects (`/project`)
        if (req.method === "GET" && path === "/project") {
          return jsonResponse({ projects: db.listProjects() });
        }

        if (req.method === "POST" && path === "/project") {
          const body = (await req.json()) as {
            worktree?: string;
            name?: string;
          };
          if (!body.worktree?.trim()) {
            return jsonResponse({ error: "worktree path is required" }, 400);
          }
          const rawDir = resolve(body.worktree.trim());
          if (!existsSync(rawDir)) {
            return jsonResponse(
              { error: `Project directory does not exist: ${rawDir}` },
              400,
            );
          }
          const st = statSync(rawDir);
          if (!st.isDirectory()) {
            return jsonResponse(
              { error: `Path is not a directory: ${rawDir}` },
              400,
            );
          }
          const canonical = realpathSync(rawDir);
          const gitInfo = detectGitBranch(canonical);
          const project = db.upsertProject({
            id: `proj_${randomUUID().slice(0, 8)}`,
            worktree: canonical,
            vcs: gitInfo.vcs,
            branch: gitInfo.branch,
            name: body.name?.trim() || basename(canonical) || "project",
          });
          return jsonResponse({ project });
        }

        // 7. Sessions (`/session`)
        if (req.method === "GET" && path === "/session") {
          const projectId = url.searchParams.get("projectId") ?? undefined;
          return jsonResponse({ sessions: db.listSessions(projectId) });
        }

        if (req.method === "POST" && path === "/session") {
          const body = (await req.json()) as {
            projectId?: string;
            directory?: string;
            title?: string;
            agent?: "build" | "plan" | "explore" | "general";
            modelId?: string | null;
          };

          let targetProject = body.projectId
            ? db
                .listProjects()
                .find((p) => p.id === body.projectId) ?? null
            : null;

          if (!targetProject && body.directory?.trim()) {
            const rawDir = resolve(body.directory.trim());
            if (!existsSync(rawDir)) {
              return jsonResponse(
                { error: `Directory does not exist: ${rawDir}` },
                400,
              );
            }
            const canonical = realpathSync(rawDir);
            const gitInfo = detectGitBranch(canonical);
            targetProject = db.upsertProject({
              id: `proj_${randomUUID().slice(0, 8)}`,
              worktree: canonical,
              vcs: gitInfo.vcs,
              branch: gitInfo.branch,
              name: basename(canonical) || "project",
            });
          }

          if (!targetProject) {
            targetProject = db.listProjects()[0] ?? null;
          }

          if (!targetProject) {
            return jsonResponse(
              {
                error:
                  "No project selected. Please open a local project folder first.",
              },
              400,
            );
          }

          const sessionId = `sess_${randomUUID().slice(0, 10)}`;
          const session = db.createSession({
            id: sessionId,
            project_id: targetProject.id,
            slug: sessionId,
            directory: body.directory?.trim() || targetProject.worktree,
            title: body.title?.trim() || "New conversation",
            agent: body.agent ?? "build",
            model_id:
              body.modelId ?? cachedModels[0]?.id ?? null,
          });
          runner.emit({
            type: "session.created",
            properties: { session },
          });
          return jsonResponse({ session });
        }

        // Session subroutes (`/session/:id...`)
        const sessionMatch = path.match(/^\/session\/([^/]+)(?:\/(.+))?$/);
        if (sessionMatch) {
          const sessionId = decodeURIComponent(sessionMatch[1]);
          const subroute = sessionMatch[2] ?? "";

          if (!subroute && req.method === "GET") {
            const session = db.getSession(sessionId);
            if (!session) {
              return jsonResponse({ error: "Session not found" }, 404);
            }
            return jsonResponse({
              session,
              messages: db.listMessages(sessionId),
              artifacts: db.listArtifacts(sessionId),
              permissions: runner.listPendingPermissions(sessionId),
            });
          }

          if (!subroute && req.method === "PATCH") {
            const body = (await req.json()) as {
              title?: string;
              agent?: "build" | "plan" | "explore" | "general";
              modelId?: string | null;
            };
            const updated = db.updateSession(sessionId, {
              title: body.title,
              agent: body.agent,
              model_id: body.modelId,
            });
            if (!updated) {
              return jsonResponse({ error: "Session not found" }, 404);
            }
            runner.emit({
              type: "session.updated",
              properties: { session: updated },
            });
            return jsonResponse({ session: updated });
          }

          if (subroute === "message" && req.method === "GET") {
            return jsonResponse({
              messages: db.listMessages(sessionId),
            });
          }

          if (
            (subroute === "message" || subroute === "prompt_async") &&
            req.method === "POST"
          ) {
            const body = (await req.json()) as {
              text?: string;
              agent?: "build" | "plan" | "explore" | "general";
              modelId?: string;
              turbo?: boolean;
            };
            if (!body.text?.trim()) {
              return jsonResponse({ error: "text required" }, 400);
            }
            if (subroute === "prompt_async") {
              runner
                .runPrompt({
                  sessionId,
                  text: body.text,
                  agent: body.agent,
                  modelId: body.modelId,
                  turbo: body.turbo,
                })
                .catch(() => undefined);
              return jsonResponse({ accepted: true, sessionId }, 202);
            }
            const result = await runner.runPrompt({
              sessionId,
              text: body.text,
              agent: body.agent,
              modelId: body.modelId,
              turbo: body.turbo,
            });
            return jsonResponse({
              ...result,
              session: db.getSession(sessionId),
              messages: db.listMessages(sessionId),
              artifacts: db.listArtifacts(sessionId),
            });
          }

          if (subroute === "abort" && req.method === "POST") {
            const aborted = await runner.abortSession(sessionId);
            return jsonResponse({ ok: true, aborted });
          }

          if (subroute === "diff" && req.method === "GET") {
            const session = db.getSession(sessionId);
            if (!session) return jsonResponse({ error: "Not found" }, 404);
            return jsonResponse(runner.getWorkspaceDiff(session.directory));
          }

          if (subroute === "artifact" && req.method === "GET") {
            return jsonResponse({ artifacts: db.listArtifacts(sessionId) });
          }
        }

        // 8. Permissions (`/permission`)
        if (req.method === "GET" && path === "/permission") {
          const sessionId = url.searchParams.get("sessionId") ?? undefined;
          return jsonResponse({
            permissions: runner.listPendingPermissions(sessionId),
          });
        }

        const permReplyMatch = path.match(/^\/permission\/([^/]+)\/reply$/);
        if (permReplyMatch && req.method === "POST") {
          const permId = decodeURIComponent(permReplyMatch[1]);
          const body = (await req.json()) as {
            approved?: boolean;
            scope?: "once" | "session";
            reason?: string;
          };
          const ok = runner.replyPermission(permId, {
            approved: Boolean(body.approved),
            scope: body.scope ?? "once",
            reason: body.reason,
          });
          return jsonResponse({ ok });
        }

        // 9. Settings & Customizations (`/settings`, `/mcp`, `/skills`)
        if (req.method === "GET" && path === "/settings") {
          return jsonResponse({
            settings: settings.getSettings(),
            plugins: plugins.list(),
          });
        }

        if (
          (req.method === "PATCH" || req.method === "POST") &&
          path === "/settings"
        ) {
          const patch = (await req.json()) as Partial<DesktopSettingsState>;
          const updated = settings.updateSettings(
            patch,
            auth.getActiveAccessToken(),
          );
          return jsonResponse({ settings: updated });
        }

        if (req.method === "POST" && path === "/settings/mcp") {
          const body = (await req.json()) as {
            name?: string;
            transport?: "http" | "sse" | "stdio";
            url?: string;
            headers?: Record<string, string>;
          };
          if (!body.name?.trim() || !body.url?.trim()) {
            return jsonResponse({ error: "name and url are required" }, 400);
          }
          const mcp = settings.addMcpServer({
            name: body.name,
            transport: body.transport,
            url: body.url,
            headers: body.headers,
          });
          return jsonResponse({ mcp, settings: settings.getSettings() });
        }

        const mcpDeleteMatch = path.match(/^\/settings\/mcp\/([^/]+)$/);
        if (mcpDeleteMatch && req.method === "DELETE") {
          const id = decodeURIComponent(mcpDeleteMatch[1]);
          settings.removeMcpServer(id);
          return jsonResponse({ settings: settings.getSettings() });
        }

        if (req.method === "POST" && path === "/settings/skills") {
          const body = (await req.json()) as {
            source?: string;
            skillName?: string;
          };
          if (!body.source?.trim() || !body.skillName?.trim()) {
            return jsonResponse(
              { error: "source and skillName are required" },
              400,
            );
          }
          settings.addGlobalSkill(body.source, body.skillName);
          return jsonResponse({ settings: settings.getSettings() });
        }

        const skillDeleteMatch = path.match(/^\/settings\/skills\/(\d+)$/);
        if (skillDeleteMatch && req.method === "DELETE") {
          const idx = Number(skillDeleteMatch[1]);
          settings.removeGlobalSkill(idx);
          return jsonResponse({ settings: settings.getSettings() });
        }

        // 10. Automations / Schedules (`/schedule`)
        if (req.method === "GET" && path === "/schedule") {
          const projectId = url.searchParams.get("projectId") ?? undefined;
          return jsonResponse({ schedules: db.listSchedules(projectId) });
        }

        if (req.method === "POST" && path === "/schedule") {
          const body = (await req.json()) as {
            projectId?: string;
            name?: string;
            cron?: string;
            prompt?: string;
            agent?: "build" | "plan";
          };
          if (!body.name?.trim() || !body.cron?.trim() || !body.prompt?.trim()) {
            return jsonResponse(
              { error: "name, cron, and prompt are required" },
              400,
            );
          }
          let targetProject = body.projectId
            ? db.listProjects().find((p) => p.id === body.projectId) ?? null
            : db.listProjects()[0] ?? null;

          if (!targetProject) {
            const cwd = process.cwd();
            targetProject = db.upsertProject({
              id: `proj_${randomUUID().slice(0, 8)}`,
              worktree: cwd,
              vcs: "git",
              branch: "main",
              name: basename(cwd) || "project",
            });
          }

          const schedule = db.upsertSchedule({
            id: `sched_${randomUUID().slice(0, 8)}`,
            project_id: targetProject.id,
            name: body.name.trim(),
            cron: body.cron.trim(),
            prompt: body.prompt.trim(),
            agent: body.agent ?? "build",
            enabled: true,
          });
          return jsonResponse({
            schedule,
            schedules: db.listSchedules(),
          });
        }


        const schedDeleteMatch = path.match(/^\/schedule\/([^\/]+)$/);
        if (schedDeleteMatch && req.method === "DELETE") {
          const schedId = schedDeleteMatch[1];
          db.query("DELETE FROM schedule WHERE id = ?").run(schedId);
          return jsonResponse({ ok: true, schedules: db.listSchedules() });
        }

        const schedToggleMatch = path.match(/^\/schedule\/([^\/]+)\/toggle$/);
        if (schedToggleMatch && req.method === "POST") {
          const schedId = schedToggleMatch[1];
          const curr = db.query("SELECT enabled FROM schedule WHERE id = ?").get(schedId) as { enabled: number } | null;
          if (curr) {
            const next = curr.enabled ? 0 : 1;
            db.query("UPDATE schedule SET enabled = ?, time_updated = ? WHERE id = ?").run(next, Date.now(), schedId);
          }
          return jsonResponse({ ok: true, schedules: db.listSchedules() });
        }

        const schedRunMatch = path.match(/^\/schedule\/([^\/]+)\/run$/);
        if (schedRunMatch && req.method === "POST") {
          const schedId = schedRunMatch[1];
          const sched = db.query("SELECT * FROM schedule WHERE id = ?").get(schedId) as any;
          if (sched) {
            const sess = db.upsertSession({
              id: `sess_sched_${randomUUID().slice(0, 8)}`,
              project_id: sched.project_id,
              title: `[Scheduled] ${sched.name}`,
              agent: sched.agent || "build",
            });
            // Update last run
            db.query("UPDATE schedule SET last_run_at = ?, last_status = 'running', time_updated = ? WHERE id = ?").run(
              Date.now(), schedId
            );
            return jsonResponse({ ok: true, session: sess });
          }
          return jsonResponse({ error: "Schedule not found" }, 404);
        }

        if (req.method === "GET" && path === "/plugin") {
          return jsonResponse({ plugins: plugins.list() });
        }

        return jsonResponse({ error: `Route not found: ${path}` }, 404);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("HTTP 401")
          ? 401
          : message.includes("HTTP 402")
            ? 402
            : message.includes("HTTP 403")
              ? 403
              : 500;
        return jsonResponse({ error: message }, status);
      }
    },
  });

  const actualPort = server.port ?? port;
  return {
    port: actualPort,
    hostname,
    url: `http://${hostname}:${actualPort}`,
    db,
    auth,
    settings,
    runner,
    stop: () => {
      server.stop(true);
      db.close();
    },
  };
}
