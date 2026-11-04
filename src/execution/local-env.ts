/**
 * Entry Desktop V1 — Local Execution Environment
 *
 * Implements Section 6 of the Entry Desktop V1 Implementation Specification:
 * 1. Canonical `realpath` path containment within the user's selected project directory.
 * 2. Controlled process execution with environment scrubbing, working directory validation,
 *    execution timeouts, output size bounds (2,000 lines / 50 KiB), and process-tree cancellation.
 * 3. Background process tracking (`run_command`, `read_process_output`, `cancel_process`).
 * 4. Explicit documentation of V1 OS-level isolation boundaries:
 *    - V1 enforces pre-execution permission gates, canonical path checks, env scrubbing,
 *      and process-tree lifecycle management.
 *    - Approved shell commands execute on the host OS under the current user's privileges
 *      (not inside a kernel namespace or VM).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MAX_OUTPUT_LINES = 2000;
export const MAX_OUTPUT_BYTES = 50 * 1024; // 50 KiB
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000; // 2 minutes

const SCRUBBED_ENV_KEYS = new Set([
  "ENTRY_SESSION_TOKEN",
  "ENTRY_SERVER_PASSWORD",
  "ENTRY_CREDENTIAL_KEY",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "AI_GATEWAY_API_KEY",
]);

export interface BoundedOutputResult {
  content: string;
  truncated: boolean;
  totalBytes: number;
  totalLines: number;
  overflowPath?: string;
}

export interface ManagedProcessInfo {
  id: string;
  sessionId: string;
  pid: number | undefined;
  command: string;
  cwd: string;
  status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  stdout: string;
  stderr: string;
}

interface InternalProcessRecord extends ManagedProcessInfo {
  child: ChildProcess;
  timer?: ReturnType<typeof setTimeout>;
  completionPromise: Promise<ManagedProcessInfo>;
}

/**
 * Truncates large tool or command outputs to `MAX_OUTPUT_LINES` (2,000) and
 * `MAX_OUTPUT_BYTES` (50 KiB), spilling the full text to `~/.entry/desktop/tool-output/`
 * so the model can inspect specific line ranges via `read_file` if needed.
 */
export function truncateToolOutput(
  text: string,
  toolPrefix = "output",
): BoundedOutputResult {
  const byteLength = Buffer.byteLength(text, "utf-8");
  const lines = text.split("\n");

  if (lines.length <= MAX_OUTPUT_LINES && byteLength <= MAX_OUTPUT_BYTES) {
    return {
      content: text,
      truncated: false,
      totalBytes: byteLength,
      totalLines: lines.length,
    };
  }

  let overflowPath: string | undefined;
  try {
    const outDir = join(homedir(), ".entry", "desktop", "tool-output");
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    overflowPath = join(
      outDir,
      `${toolPrefix}_${Date.now()}_${randomUUID().slice(0, 8)}.txt`,
    );
    writeFileSync(overflowPath, text, { encoding: "utf-8", mode: 0o600 });
  } catch {
    overflowPath = undefined;
  }

  const keptLines: string[] = [];
  let currentBytes = 0;
  for (let i = 0; i < Math.min(lines.length, MAX_OUTPUT_LINES); i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
    if (currentBytes + lineBytes > MAX_OUTPUT_BYTES) {
      break;
    }
    keptLines.push(line);
    currentBytes += lineBytes;
  }

  const notice = overflowPath
    ? `\n\n... [Output truncated: showing ${keptLines.length} of ${lines.length} lines (${currentBytes} of ${byteLength} bytes). Full output saved to ${overflowPath}]`
    : `\n\n... [Output truncated: showing ${keptLines.length} of ${lines.length} lines (${currentBytes} of ${byteLength} bytes).]`;

  return {
    content: keptLines.join("\n") + notice,
    truncated: true,
    totalBytes: byteLength,
    totalLines: lines.length,
    overflowPath,
  };
}

/**
 * Resolves a candidate path against `projectRoot` and verifies whether it stays
 * inside the canonical `realpath` of `projectRoot`.
 */
export function resolveAndCheckProjectPath(
  projectRoot: string,
  targetPath: string,
): {
  resolvedPath: string;
  canonicalProjectRoot: string;
  insideProject: boolean;
  relativePath: string;
} {
  const canonicalProjectRoot = existsSync(projectRoot)
    ? realpathSync(projectRoot)
    : resolve(projectRoot);

  const rawResolved = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(canonicalProjectRoot, targetPath);

  // Resolve existing ancestor to prevent symlink traversal escapes
  let canonicalTarget = rawResolved;
  try {
    if (existsSync(rawResolved)) {
      canonicalTarget = realpathSync(rawResolved);
    } else {
      let ancestor = dirname(rawResolved);
      const tailSegments: string[] = [rawResolved.slice(ancestor.length)];
      while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
        const parent = dirname(ancestor);
        tailSegments.unshift(ancestor.slice(parent.length));
        ancestor = parent;
      }
      if (existsSync(ancestor)) {
        canonicalTarget = join(realpathSync(ancestor), ...tailSegments);
      }
    }
  } catch {
    canonicalTarget = rawResolved;
  }

  const rel = relative(canonicalProjectRoot, canonicalTarget);
  const insideProject =
    rel === "" ||
    (!rel.startsWith("..") && !isAbsolute(rel));

  return {
    resolvedPath: canonicalTarget,
    canonicalProjectRoot,
    insideProject,
    relativePath: rel || ".",
  };
}

/**
 * Terminates a process and its entire descendant tree on Windows (`taskkill /PID /T /F`)
 * or POSIX (`process.kill(-pid, "SIGTERM")` -> `"SIGKILL"`).
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 4000,
        windowsHide: true,
      });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }

  await new Promise((r) => setTimeout(r, 200));

  try {
    process.kill(-pid, 0);
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
}

export class LocalExecutionManager {
  private readonly processes = new Map<string, InternalProcessRecord>();

  /**
   * Builds a scrubbed environment dictionary for child processes so internal
   * Entry tokens or server secrets are never leaked into shell commands.
   */
  buildChildEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!SCRUBBED_ENV_KEYS.has(k) && v !== undefined) {
        env[k] = v;
      }
    }
    env.CI = env.CI ?? "1";
    env.TERM = "dumb";
    if (extraEnv) {
      for (const [k, v] of Object.entries(extraEnv)) {
        if (!SCRUBBED_ENV_KEYS.has(k)) {
          env[k] = v;
        }
      }
    }
    return env;
  }

  /**
   * Starts a command in `cwd` with timeout, cancellation signal, and output collection.
   * If `background` is true, waits briefly (`backgroundStartupMs`, default 250ms) to
   * capture any immediate startup failure, then returns the running `ManagedProcessInfo`
   * so the agent can inspect it via `read_process_output` or stop it via `cancel_process`.
   */
  async startCommand(options: {
    sessionId: string;
    command: string;
    cwd: string;
    timeoutMs?: number;
    background?: boolean;
    backgroundStartupMs?: number;
    signal?: AbortSignal;
  }): Promise<ManagedProcessInfo> {
    const id = `proc_${randomUUID().slice(0, 10)}`;
    const timeoutMs = Math.max(
      500,
      Math.min(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 600_000),
    );

    const isWin = process.platform === "win32";
    const shell = isWin ? "powershell.exe" : "/bin/bash";
    const shellArgs = isWin
      ? ["-NoProfile", "-NonInteractive", "-Command", options.command]
      : ["-c", options.command];

    const child = spawn(shell, shellArgs, {
      cwd: options.cwd,
      env: this.buildChildEnv(),
      detached: !isWin,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let resolveDone!: (info: ManagedProcessInfo) => void;
    const completionPromise = new Promise<ManagedProcessInfo>((res) => {
      resolveDone = res;
    });

    const record: InternalProcessRecord = {
      id,
      sessionId: options.sessionId,
      pid: child.pid,
      command: options.command,
      cwd: options.cwd,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      stdout: "",
      stderr: "",
      child,
      completionPromise,
    };

    this.processes.set(id, record);

    const maxBufferKeep = MAX_OUTPUT_BYTES * 4;
    child.stdout?.on("data", (chunk: Buffer) => {
      record.stdout += chunk.toString("utf-8");
      if (record.stdout.length > maxBufferKeep) {
        record.stdout = record.stdout.slice(-maxBufferKeep);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      record.stderr += chunk.toString("utf-8");
      if (record.stderr.length > maxBufferKeep) {
        record.stderr = record.stderr.slice(-maxBufferKeep);
      }
    });

    const onAbort = () => {
      if (record.status === "running") {
        record.status = "cancelled";
        if (record.timer) clearTimeout(record.timer);
        void killProcessTree(child).finally(() => {
          if (!record.endedAt) record.endedAt = Date.now();
          resolveDone(this.toPublicInfo(record));
        });
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    record.timer = setTimeout(() => {
      if (record.status === "running") {
        record.status = "timed_out";
        void killProcessTree(child);
      }
    }, timeoutMs);

    child.on("error", (err) => {
      if (record.timer) clearTimeout(record.timer);
      options.signal?.removeEventListener("abort", onAbort);
      record.stderr += `\nProcess error: ${err.message}`;
      if (record.status === "running") {
        record.status = "failed";
      }
      record.endedAt = Date.now();
      resolveDone(this.toPublicInfo(record));
    });

    child.on("close", (code) => {
      if (record.timer) clearTimeout(record.timer);
      options.signal?.removeEventListener("abort", onAbort);
      record.exitCode = code;
      record.endedAt = Date.now();
      if (record.status === "running") {
        record.status = code === 0 ? "completed" : "failed";
      }
      resolveDone(this.toPublicInfo(record));
    });

    if (options.background) {
      const waitMs = options.backgroundStartupMs ?? 250;
      await Promise.race([
        completionPromise,
        new Promise((r) => setTimeout(r, waitMs)),
      ]);
      return this.toPublicInfo(record);
    }

    return completionPromise;
  }

  getProcess(processId: string): ManagedProcessInfo | null {
    const rec = this.processes.get(processId);
    return rec ? this.toPublicInfo(rec) : null;
  }

  listSessionProcesses(sessionId: string): ManagedProcessInfo[] {
    const list: ManagedProcessInfo[] = [];
    for (const rec of this.processes.values()) {
      if (rec.sessionId === sessionId) {
        list.push(this.toPublicInfo(rec));
      }
    }
    return list;
  }

  async cancelProcess(processId: string): Promise<ManagedProcessInfo | null> {
    const rec = this.processes.get(processId);
    if (!rec) return null;
    if (rec.status === "running" || rec.endedAt === null) {
      rec.status = "cancelled";
      if (rec.timer) clearTimeout(rec.timer);
      await killProcessTree(rec.child);
      await Promise.race([
        rec.completionPromise,
        new Promise((r) => setTimeout(r, 500)),
      ]);
      if (!rec.endedAt) rec.endedAt = Date.now();
    }
    return this.toPublicInfo(rec);
  }

  async cancelSessionProcesses(sessionId: string): Promise<number> {
    let count = 0;
    for (const rec of this.processes.values()) {
      if (
        rec.sessionId === sessionId &&
        (rec.status === "running" || rec.endedAt === null)
      ) {
        count++;
        await this.cancelProcess(rec.id);
      }
    }
    return count;
  }

  private toPublicInfo(rec: InternalProcessRecord): ManagedProcessInfo {
    return {
      id: rec.id,
      sessionId: rec.sessionId,
      pid: rec.pid,
      command: rec.command,
      cwd: rec.cwd,
      status: rec.status,
      exitCode: rec.exitCode,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      stdout: rec.stdout,
      stderr: rec.stderr,
    };
  }
}
