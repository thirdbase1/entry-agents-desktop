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
import { existsSync, realpathSync, statSync } from "node:fs";
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
  const runner = new EntrySessionRunner(db, plugins, entryBaseUrl, auth);

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
    runner,
    stop: () => {
      server.stop(true);
      db.close();
    },
  };
}
