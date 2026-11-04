# OpenCode Technical Architecture Research & Entry Desktop V1 Adaptation

## Overview & Repository Layout Inspection

In the current `anomalyco/opencode` repository, the historical `packages/opencode/src/*` runtime modules have been consolidated into `packages/core/src/*` alongside `packages/schema/*`, `packages/ai/*`, `packages/util/*`, `packages/server/*`, and `packages/desktop/*`.

This document analyzes how OpenCode implements its five core local-agent subsystems from actual source code inspection, evaluates their security properties, and specifies what **Entry Desktop V1** adopts versus what Entry implements differently to integrate cleanly with Entry's existing backend (`apps/web`), agent package (`@entry-agents/agent`), and sandbox package (`@entry-agents/sandbox`).

---

## A. Tool Architecture

### 1. How OpenCode Implements It
- **Registration & Discovery**: `Tool.Service` (`packages/core/src/tool.ts`) maintains an `Editor` registry (`list`, `get`, `namespace`, `add`, `update`, `remove`). Built-in tools are registered as modular plugins under `packages/core/src/tool/plugin/*.ts` (`read.ts`, `write.ts`, `edit.ts`, `glob.ts`, `grep.ts`, `shell.ts`, `patch.ts`, `todo.ts`, `question.ts`, `webfetch.ts`, `websearch.ts`, `subagent.ts`, `artifact.ts`, `schedule.ts`).
- **Schema Conversion & Caching**: `packages/core/src/tool/runtime.ts` converts Effect/StandardSchema/Zod input and output schemas into normalized Draft 2020-12 JSON Schemas (`definition()`), flattening `allOf` and inlining local `$defs` so LLM providers receive clean flat tool schemas without busting prompt caches.
- **Input Validation & Self-Correction**: Before `tool.execute()` runs, `decodeInput()` validates raw LLM arguments against the schema. If validation fails, `formatInputIssues()` formats up to 5 path-annotated schema issues plus the raw JSON arguments and returns a structured `Tool.Error` message instructing the model to fix its arguments and retry.
- **Execution & Lifecycle**: During a session step (`packages/core/src/session/runner/step.ts`), when the LLM stream emits a `ToolCall`, the runner publishes `Tool.Called` first, forks a tool execution fiber (`executeTool`), streams progress metadata (`publisher.progress`), and normalizes output content (`normalizeContent`).
- **Output Truncation & Spill-to-Disk**: `ToolOutput.Service` (`packages/core/src/tool-output.ts`) enforces strict output ceilings (`MAX_LINES = 2000`, `MAX_BYTES = 50 * 1024` / 50 KiB). When tool output exceeds either limit, the full output is saved to `<data>/tool-output/tool_<id>` (retained for 7 days) and the inline tool result is replaced with the first N lines plus `[showing lines 1-N of M; full output saved to <path>]`.

### 2. Relevant Source Files
- `packages/core/src/tool.ts`
- `packages/core/src/tool/runtime.ts`
- `packages/core/src/tool-output.ts`
- `packages/core/src/tool/plugin/{read,write,edit,glob,grep,shell,todo,question}.ts`
- `packages/core/src/session/runner/step.ts`

### 3. Important Design Decisions
- Validation errors and runtime tool failures are converted into structured tool-result errors rather than crashing the turn loop, enabling the model to self-correct on the next round.
- Output truncation happens uniformly at the tool boundary so a single noisy command or file read cannot overflow the model's context window.

### 4. Security Implications
- Untrusted tool outputs can contain prompt injection or massive payloads; bounding inline bytes (50 KiB) and isolating tool execution behind schema validation + permission assertion prevents resource exhaustion and unchecked argument injection.

### 5. What Entry Desktop V1 Adopts
- Explicit JSON Schema definitions and Zod/runtime argument validation for every tool (`read_file`, `create_file`, `edit_file`, `list_directory`, `search_files`, `search_content`, `run_command`, `read_process_output`, `cancel_process`, `project_info`, `working_directory`, `git_status`, `git_diff`).
- Multi-round tool-calling loop supporting parallel tool calls in a single assistant turn, structured validation error returns to the model, and strict 50 KiB / 2,000-line output truncation.
- Real-time tool lifecycle state machine surfaced to the native Rust UI (`thinking` -> `tool_requested` -> `waiting_permission` -> `tool_executing` -> `tool_completed` / `tool_failed` -> `final_response`).

### 6. What Entry Desktop V1 Implements Differently
- Instead of adopting OpenCode's Effect-TS dependency graph (`effect`, `@opencode/ai/effect`, `@opencode/schema`), Entry Desktop V1 uses plain TypeScript + Zod in the Bun sidecar (`apps/desktop`) and reuses Entry's existing `/v1/chat/completions` gateway transport.

---

## B. Permission Architecture

### 1. How OpenCode Implements It
- **Three-State Ruleset (`allow` | `ask` | `deny`)**: `Permission.Service` (`packages/core/src/permission.ts`) evaluates ordered rulesets (`{ action, resource, effect }`) using `Wildcard.match` (`findLast` wins; defaults to `ask` if no rule matches).
- **Path & External Directory Boundaries**: `FileAccess.Service` (`packages/core/src/file-access.ts`) resolves every requested path relative to the active project `Location`. If a path resolves outside the project worktree, `FileAccess` attaches an `external_directory` authorization requirement (`action: "external_directory"`) that must be approved before the underlying `read`/`edit`/`write`/`shell` action is evaluated.
- **Command-Level Permissions**: `ShellParse.scan` (`packages/core/src/shell/parse.ts` & `scan.ts`) parses shell command strings into individual sub-commands and referenced directories, asserting permissions for each extracted command resource and external directory.
- **Interactive Approval & Session/Project Persistence**: When evaluation yields `"ask"`, `Permission.Service` creates a `Deferred` request, publishes `Permission.Event.Asked` on the event bus, and suspends the tool fiber until `reply({ requestID, reply })` is called (`"once"`, `"always"`, `"reject"`, or `"correct"` with user feedback). `"always"` persists the rule to SQLite (`packages/core/src/permission/saved.ts`).

### 2. Relevant Source Files
- `packages/core/src/permission.ts`
- `packages/core/src/permission/saved.ts`
- `packages/core/src/permission/sql.ts`
- `packages/core/src/file-access.ts`
- `packages/core/src/shell/parse.ts`
- `packages/core/src/filesystem/protected.ts`

### 3. Important Design Decisions
- Last-matching-rule semantics allow broad defaults (e.g., allow reads inside the project) followed by specific overrides (e.g., ask on `.env*`, `.git/config`, `.ssh/*`, or destructive shell commands).
- External directory access is a distinct permission action (`external_directory`) separate from in-project file access.

### 4. Security Implications
- Application-level permission checks gate cooperative tool calls before execution, preventing accidental writes outside the workspace, `.env` secret exfiltration, or unapproved shell execution. However, once a shell command is approved and spawned as a normal OS user process, application-level permission rules do not prevent that child process from making direct OS syscalls.

### 5. What Entry Desktop V1 Adopts
- `allow` | `ask` | `deny` rule evaluation with wildcard matching on both tool action and resource path/command.
- Automatic protection for sensitive files (`.env`, `.env.*` except `.env.example`, `.git/hooks/*`, credentials/keys), external paths outside the project root, and mutating/destructive shell commands (`rm`, `del`, `Remove-Item`, `git push`, `git reset --hard`, `curl | sh`, network/package mutations).
- Live approval queue in the native Rust UI (`Allow Once`, `Allow for Session`, `Deny`) that blocks execution until the user decides.

### 6. What Entry Desktop V1 Implements Differently
- Entry Desktop V1 stores session-level and persistent project permission decisions directly in the local SQLite database (`~/.entry/desktop/state.sqlite`) and exposes synchronous/SSE-backed `/permission` endpoints to the native `eframe`/`egui` GUI.

---

## C. Local Execution

### 1. How OpenCode Implements It
- **Non-Interactive Shell Service**: `Shell.Service` (`packages/core/src/shell.ts`) spawns commands via `CrossSpawnSpawner` / `AppProcess`, streams combined stdout/stderr to a per-command capture file (`sh_<id>.out`), and tracks active vs. exited processes (`EXITED_LIMIT = 25`).
- **Shell Selection**: `ShellSelect` (`packages/core/src/shell/select.ts`) selects a deterministic non-interactive shell (`bash`/`sh` on POSIX, `powershell.exe`/`cmd.exe` on Windows).
- **Timeouts, Backgrounding & Cancellation**: Foreground commands default to `DEFAULT_TIMEOUT_MS = 120_000` (2 minutes). `ShellTool` (`packages/core/src/tool/plugin/shell.ts`) supports `background: true`, which returns a `shellID` immediately while streaming output to disk and notifying the session when the background job settles. Cancellation interrupts the process fiber and kills the OS process tree.

### 2. Relevant Source Files
- `packages/core/src/shell.ts`
- `packages/core/src/shell/select.ts`
- `packages/core/src/shell/result.ts`
- `packages/core/src/tool/plugin/shell.ts`
- `packages/core/src/pty.ts`

### 3. Important Design Decisions
- Every spawned process has an opaque handle (`shellID` / `processId`), a sanitized environment, a validated working directory inside the project, a hard timeout timer, and process-tree termination (`taskkill /T /F` on Windows, negative PGID `kill(-pid)` on POSIX).

### 4. Security Implications
- Spawning child processes without environment sanitization can leak host/sidecar tokens. Process cancellation that only kills the parent shell PID leaves orphaned grandchild processes running.

### 5. What Entry Desktop V1 Adopts
- Dedicated process registry in the local execution engine supporting foreground execution (`run_command`), live output inspection (`read_process_output`), and true process-tree cancellation (`cancel_process`) using `taskkill /PID <pid> /T /F` on Windows and process-group `SIGTERM` -> `SIGKILL` escalation on POSIX, building on `@entry-agents/sandbox`'s `LocalSandbox`.
- Strict environment variable scrubbing so `ENTRY_SESSION_TOKEN` or auth secrets are never inherited by agent-spawned subprocesses.

### 6. What Entry Desktop V1 Implements Differently
- Entry integrates its existing `LocalSandbox` (`packages/sandbox/local/sandbox.ts`) with an explicit process manager that tracks both active foreground commands and background/long-running processes by `processId`, allowing both the model (`read_process_output`, `cancel_process`) and the user (Stop button in UI) to terminate running processes immediately.

---

## D. Filesystem Operations

### 1. How OpenCode Implements It
- **Read (`read.ts` & `read-filesystem.ts`)**: Resolves paths via `FileAccess.authorizeRead`, supports line-numbered pagination (`offset`, `limit`), binary file rejection, and directory listing pagination when a directory path is passed.
- **Write (`write.ts` & `file-mutation.ts`)**: Acquires a per-path `KeyedMutex` lock (`FileMutation.withLock`), preserves UTF-8 BOM if present (`writeTextPreservingBom`), creates parent directories as needed, and records whether the file previously existed.
- **Edit (`edit.ts`)**: Performs exact or line-normalized replacement (`oldString` -> `newString`, `replaceAll`), preserves dominant CRLF vs. LF line endings (`withRegionEndings`), and returns structured `FileDiff.Info` additions/deletions.
- **Search (`glob.ts`, `grep.ts`, `ripgrep.ts`, `filesystem/search.ts`)**: Uses ripgrep / fast filesystem traversal bounded by result limits and respecting `.gitignore`.

### 2. Relevant Source Files
- `packages/core/src/tool/plugin/{read,write,edit,glob,grep}.ts`
- `packages/core/src/tool/read-filesystem.ts`
- `packages/core/src/file-mutation.ts`
- `packages/core/src/file-write.ts`
- `packages/core/src/ripgrep.ts`

### 3. Important Design Decisions
- Line endings (CRLF on Windows vs. LF) are preserved during `edit` so git diffs are not polluted with whole-file line-ending changes.
- Path resolution canonicalizes `realpath` and checks containment against the project root.

### 4. Security Implications
- Symlink traversal or `..\` segments can escape a project folder if only lexical `path.join` is used without canonical `realpath` containment verification.

### 5. What Entry Desktop V1 Adopts
- Canonical `realpath` containment checks (via `LocalSandbox` + path security guards), CRLF-preserving file edits, line-numbered file reads with offset/limit, directory listing, glob file search, and regex content search.

### 6. What Entry Desktop V1 Implements Differently
- Entry Desktop V1 provides explicit, focused tools matching Section 7 of the V1 specification: `read_file`, `create_file`, `edit_file`, `list_directory`, `search_files`, `search_content`, plus project/Git inspection tools (`project_info`, `working_directory`, `git_status`, `git_diff`).

---

## E. Project Isolation & Security Limitations

### 1. How OpenCode Implements It
- **Project & Worktree Identity**: `Project.Service` (`packages/core/src/project.ts`) identifies projects by Git root commit or canonical worktree directory, storing metadata in SQLite. `Worktree.Service` (`packages/core/src/worktree.ts`) manages isolated Git worktrees per session when requested.
- **Location Scoping**: Every session is bound to a `Location` (directory) so all `FileAccess`, `Shell`, and `Permission` services operate strictly relative to that project root.

### 2. Relevant Source Files
- `packages/core/src/project.ts`
- `packages/core/src/worktree.ts`
- `packages/core/src/location.ts`
- `packages/core/src/workspace.ts`

### 3. Important Design Decisions & Security Implications
- OpenCode scopes filesystem and shell tools to the active project worktree and gates external paths or shell commands behind user permissions, but runs local commands as the host user without kernel-level VM/container isolation.

### 4. Entry Desktop V1 Isolation Architecture & Explicit V1 Security Limitation Notice
- **What Entry Desktop V1 Enforces**:
  1. **Canonical Path Containment**: All filesystem tools resolve realpaths (`fs.realpath`) and reject any path outside the active project's canonical root directory unless the user explicitly approves an `external_directory` permission prompt.
  2. **Working Directory Enforcement**: All shell commands and Git operations validate that `cwd` is an existing directory inside the active project root before spawning.
  3. **Environment Scrubbing**: Auth tokens and internal sidecar credentials are stripped from child process environments.
  4. **Command & Sensitive-Path Permission Gate**: Mutating shell commands, destructive operations (`rm -rf`, `git reset --hard`, `git push`, etc.), and sensitive files (`.env*`, `.git/config`, keys) require explicit user approval (`ask`) or are blocked (`deny`).
  5. **Process Ownership & Tree Termination**: Every child process is tracked by an opaque ID and terminated as a full process tree on timeout or user cancellation.
- **Explicit V1 Limitation (OS-Level Isolation vs. Permission Checks)**:
  - In Entry Desktop V1 on Windows/macOS/Linux, local shell commands approved by the user execute as subprocesses under the user's OS account rather than inside a hardware-virtualized micro-VM or OS kernel sandbox (such as Windows AppContainer/Job-Object filesystem virtualization).
  - **Permission checks and path containment are application-level controls and are NOT equivalent to OS-level sandboxing.** Once a user approves a shell command, that process has the OS privileges of the local user account.
