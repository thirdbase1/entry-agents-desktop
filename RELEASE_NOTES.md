# Entry Desktop v1.1.0 — Native Rust AI Coding Agent

Entry Desktop v1.1.0 is a native, high-performance AI coding agent environment built in Rust (`eframe`/`egui`) with a dedicated local sidecar runtime (`Bun`). It connects directly to your Entry account and live backend models to perform verified development tasks directly on your local project directories.

---

## 🚀 Key Highlights

### 1. Genuine Native 3-Column Workspace (Zero Electron, Zero WebView)
- **Ultra-fast Native GUI**: Crafted in native Rust (`eframe`/`egui`) with a dark palette (`#141414`, `#1b1b1b`, `#181818`, `#212121`, `#0a84ff`) matching the approved three-column layout.
- **Entry Favicon Branding**: Windows executable icon, taskbar icon, sidebar branding, and login card are generated from the official Entry 3-bar SVG mark.
- **Zero Demo / Mock Data**: No hardcoded mock models, simulated sessions, or non-working decorative controls. Everything operates on actual projects, real Entry gateway models, and real local tools.

### 2. Live Entry Model Integration & Streaming
- Discovers live models from Entry backend (`apps/web/app/api/desktop/models`).
- Seamless switching between models from the composer menu.
- Full support for **Build Mode** (full tool execution) and **Plan Mode** (read-only architectural analysis & plan generation).
- Real-time token streaming with automatic fallback, rate limit recovery, and in-flight context overflow compaction.

### 3. Full 13-Tool Execution Loop with Security & Permission Sandboxing
- **13 Real Tools**: `read_file`, `create_file`, `edit_file`, `list_directory`, `search_content`, `find_files`, `file_info`, `delete_file`, `copy_file`, `move_file`, `run_command`, `git_status`, `git_diff`.
- **Granular Permission Gate**: Tools accessing files outside project worktrees or executing destructive commands trigger real-time approval requests in the chat thread (`Approve Once`, `Approve for Session`, `Deny`).
- **Real-Time Lifecycle Cards**: Chat thread displays distinct states: `Thinking...`, `Tool requested`, `Waiting for permission`, `Tool executing` (with live spinner), `Tool completed` (with expandable output), and `Tool failed`.

### 4. Comprehensive Settings (Entry Web + OpenCode Runtime)
- **Profile & Usage**: Shows authenticated user email, active subscription plan, and real-time Entry credit balance.
- **Preferences**:
  - Theme (Dark / Light / System) & Diff Mode (Unified / Split).
  - Permission Mode (Ask / Auto-Accept / Full Access).
  - Git Auto-Commit & Push, Auto-Create PR, and Guided Frontend Preview toggles.
  - Desktop notifications and subtle audio chimes on tool permission requests.
- **Model Configuration**: Default primary agent model and subagent model selection.
- **MCP Servers**: Full management of Model Context Protocol servers over HTTP, SSE, and Stdio transports (`/settings/mcp`).
- **Global Skills**: Install and toggle community skills directly from GitHub repositories (`/settings/skills`).
- **OpenCode Runtime Controls**:
  - Context auto-compaction toggle.
  - Verification gate: requires agents to run test suites and verify changes before reporting completion.
  - Configurable command timeouts (10s – 600s), max output line limits (up to 10,000 lines), and shell selection (`powershell.exe`, `bash`, `cmd.exe`).
  - Custom system prompt instructions injected into every session.
- **Automations (`/schedule`)**: Built-in cron scheduler to configure recurring background agent tasks and timers.

### 5. Secure Device Authorization
- Native OAuth 2.0 Device Authorization flow (`/api/desktop/device/start` & `/poll`).
- Opens user's browser with 6-digit confirmation code.
- Secure OS credential store with automated session renewal.

---

## 📦 Windows Installation

1. Download **`Entry-Desktop-Setup.exe`** below.
2. Run the installer (installs into `%LOCALAPPDATA%\Programs\EntryDesktop` and registers Start Menu + Desktop shortcuts).
3. Launch **Entry Desktop** and click **Sign In** to connect your Entry account.
