# Entry Desktop V1

Entry Desktop V1 is a native AI coding agent for local software projects, built inside the Entry Agents monorepo and powered by Entry's existing backend and model gateway.

## Architecture

- **Native Rust GUI (`apps/desktop/native-gui/src/main.rs` -> `entry-desktop.exe`)**:
  - Pure native `eframe` / `egui` desktop interface (zero Electron, zero WebView).
  - Implements the approved 3-column dark workspace (`#141414` / `#1b1b1b` / `#181818` / `#212121` / `#0a84ff`, left `335px`, center `1fr`, right `560px`).
  - Native desktop login screen integrated with Entry's device authorization flow (`/api/desktop/device/start` & `/api/desktop/device/poll`).
  - Live model selector, real-time tool lifecycle cards (`Thinking`, `Tool requested`, `Waiting for permission`, `Tool executing`, `Tool completed`, `Tool failed`, `Final response`), inline permission approval controls (`Approve Once`, `Approve for Session`, `Deny`), and workspace diff/artifact viewer.
- **Local Agent Sidecar (`apps/desktop/src/` -> `entry-agent-sidecar.exe`)**:
  - **Authentication & OS Credential Store (`src/auth/credential-store.ts`, `src/auth/device-auth.ts`)**: Stores session tokens using Windows DPAPI (`CurrentUser`), macOS Keychain, or Linux `secret-tool` / `0600` AES-256-GCM encrypted store, and loads real account info from `/api/desktop/usage`.
  - **Live Model Integration (`src/models/live-models.ts`)**: Fetches real models from `/api/desktop/models` and `/api/models` with zero hardcoded models or automatic model routing.
  - **Local Execution Environment (`src/execution/local-env.ts`)**: Enforces canonical `realpath` project containment, scrubbed child process environments, execution timeouts, 2,000-line / 50 KiB output truncation with overflow spill files, and full process-tree termination (`taskkill /PID /T /F` on Windows, process group `SIGTERM`/`SIGKILL` on POSIX).
  - **Permission Engine (`src/permission/permission.ts`)**: Evaluates `allow`, `ask`, and `deny` rulesets for sensitive files (`.env*`, `.git/config`, `.git/hooks/*`, `*.pem`, `*.key`), external directories, and destructive commands.
  - **13 Local Tools (`src/tools/toolset.ts`)**:
    - Filesystem: `read_file`, `create_file`, `edit_file`, `list_directory`, `search_files`, `search_content`
    - Execution: `run_command`, `read_process_output`, `cancel_process`
    - Project: `project_info`, `working_directory`, `git_status`, `git_diff`
  - **Multi-Round Streaming Tool Loop (`src/server/session-runner.ts`)**: Executes multi-tool, multi-round streaming conversations against Entry's `/v1/chat/completions` gateway.

## Running & Testing

```bash
# Run the 11-scenario acceptance test suite
cd apps/desktop
bun test

# Build the Windows sidecar executable
bun run build:sidecar:win

# Build the native Windows GUI executable
cd native-gui
cargo build --release --target x86_64-pc-windows-gnu
```
