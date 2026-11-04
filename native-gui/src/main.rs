#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Entry Desktop V1 — Native 3-Column Rust GUI (`entry-desktop.exe`)
//!
//! Faithfully implements the approved `three-column-workspace.html` design and
//! Sections 2, 3, 4, and 10 of the Entry Desktop V1 Implementation Specification:
//!
//! 1. **Native Desktop Login Screen**:
//!    - Shown when unauthenticated (`!auth.authenticated`).
//!    - Entry branding, device authorization flow (`/auth/device/start` + `/auth/device/poll`),
//!      clear verification instructions, loading spinner, expired authorization handling,
//!      authentication error handling, manual session token option, and persistent session.
//! 2. **Approved 3-Column Dark Workspace (`#141414` / `#1b1b1b` / `#181818` / `#212121` / `#0a84ff`)**:
//!    - **Left Column (`335px`)**: Logo, Hide Sidebar toggle, Search Conversations toggle,
//!      `+ New Conversation`, `Projects` list with `+ Open Project Folder`, `Conversations` list
//!      with search filter, and Account footer showing real user email, plan, credit balance,
//!      and `Sign Out`.
//!    - **Center Column (`1fr`)**: Header with Show Sidebar toggle, active conversation title,
//!      active project directory badge, and Show Right Panel toggle; scrollable message thread
//!      with sticky first prompt, distinct tool lifecycle cards (`Thinking`, `Tool requested`,
//!      `Waiting for permission` with inline `Approve Once` / `Approve for Session` / `Deny`,
//!      `Tool executing`, `Tool completed`, `Tool failed`, `Final response`), jump-to-bottom
//!      button, and Composer with live Model selector, `Build`/`Plan` mode toggle, and `Send`/`Stop`.
//!    - **Right Column (`560px`, collapsible & full-width expandable)**: Dynamic tabs for
//!      `Workspace Diff` and artifacts, `+` new tab button, expand/restore full-width button,
//!      and hide panel button.
//! 3. **Zero Demo Data or Simulated Functionality**:
//!    - Strictly no fake projects, fake conversations, fake models, or non-working decorative buttons.

use eframe::egui::{
    self, Align, Color32, Rounding, FontFamily, FontId, Frame, Id, Key, Layout, Margin,
    RichText, ScrollArea, Sense, Stroke, TextEdit, Vec2,
};
use serde::{Deserialize, Serialize};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

// ============================================================================
// Exact Color Palette from `three-column-workspace.html`
// ============================================================================
const BG: Color32 = Color32::from_rgb(0x14, 0x14, 0x14); // --bg:#141414
const BG_SIDE: Color32 = Color32::from_rgb(0x1b, 0x1b, 0x1b); // --bg-side:#1b1b1b
const BG_PANEL: Color32 = Color32::from_rgb(0x18, 0x18, 0x18); // --bg-panel:#181818
const BG_RAISE: Color32 = Color32::from_rgb(0x21, 0x21, 0x21); // --bg-raise:#212121
const BG_HOVER: Color32 = Color32::from_rgb(0x25, 0x25, 0x25); // --bg-hover:#252525
const BG_ACTIVE: Color32 = Color32::from_rgb(0x2d, 0x2d, 0x2d); // --bg-active:#2d2d2d
const LINE: Color32 = Color32::from_rgb(0x2a, 0x2a, 0x2a); // --line:#2a2a2a
const LINE_STRONG: Color32 = Color32::from_rgb(0x3a, 0x3a, 0x3a); // --line-strong:#3a3a3a
const TEXT: Color32 = Color32::from_rgb(0xe8, 0xe8, 0xe8); // --text:#e8e8e8
const TEXT_2: Color32 = Color32::from_rgb(0xb4, 0xb4, 0xb4); // --text-2:#b4b4b4
const TEXT_3: Color32 = Color32::from_rgb(0x7a, 0x7a, 0x7a); // --text-3:#7a7a7a
const ACCENT: Color32 = Color32::from_rgb(0x0a, 0x84, 0xff); // --accent:#0a84ff
const CODE_BG: Color32 = Color32::from_rgb(0x21, 0x21, 0x25); // --code-bg:#212125
const GREEN: Color32 = Color32::from_rgb(0x30, 0xd1, 0x58);
const AMBER: Color32 = Color32::from_rgb(0xff, 0x9f, 0x0a);
const RED: Color32 = Color32::from_rgb(0xff, 0x45, 0x3a);

// ============================================================================
// Sidecar Wire Models
// ============================================================================

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct AccountInfo {
    id: String,
    email: String,
    plan: Option<String>,
    plan_name: Option<String>,
    credit_balance_cents: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct AuthStatusResponse {
    authenticated: bool,
    account: Option<AccountInfo>,
    #[serde(rename = "entryBaseUrl")]
    entry_base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct DeviceStartResponse {
    device_code: String,
    user_code: Option<String>,
    code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct DevicePollResponse {
    status: String,
    account: Option<AccountInfo>,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct LiveModel {
    id: String,
    name: String,
    chef: String,
    #[serde(rename = "contextWindow")]
    context_window: Option<u64>,
    #[serde(rename = "maxOutputTokens")]
    max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct CreditGateInfo {
    blocked: bool,
    reason: Option<String>,
    kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct ModelsResponse {
    models: Vec<LiveModel>,
    #[serde(rename = "creditGate")]
    credit_gate: Option<CreditGateInfo>,
    #[serde(rename = "authExpired")]
    auth_expired: Option<bool>,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct ProjectRow {
    id: String,
    worktree: String,
    vcs: Option<String>,
    branch: Option<String>,
    name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct ProjectsResponse {
    projects: Vec<ProjectRow>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct SessionRow {
    id: String,
    project_id: String,
    slug: String,
    directory: String,
    title: String,
    agent: String,
    model_id: Option<String>,
    summary_additions: i64,
    summary_deletions: i64,
    summary_files: i64,
    time_updated: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct SessionsResponse {
    sessions: Vec<SessionRow>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct PartRow {
    id: String,
    message_id: String,
    session_id: String,
    part_type: String,
    data: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct MessageRow {
    id: String,
    session_id: String,
    role: String,
    agent: String,
    model_id: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    data: String,
    #[serde(default)]
    parts: Vec<PartRow>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct ArtifactRow {
    id: String,
    session_id: String,
    title: String,
    kind: String,
    file_path: Option<String>,
    content: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct PendingPermissionItem {
    id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "toolCallId")]
    tool_call_id: Option<String>,
    #[serde(rename = "toolName")]
    tool_name: String,
    permission: Option<String>,
    target: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct SessionDetailResponse {
    session: SessionRow,
    messages: Vec<MessageRow>,
    artifacts: Vec<ArtifactRow>,
    #[serde(default)]
    permissions: Vec<PendingPermissionItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct DiffResponse {
    diff: String,
    files: i64,
    additions: i64,
    deletions: i64,
}

#[derive(Debug, Clone)]
enum RightTab {
    Artifact(ArtifactRow),
    WorkspaceDiff,
    CustomNote { id: String, title: String, content: String },
}

impl RightTab {
    fn id(&self) -> String {
        match self {
            RightTab::Artifact(a) => format!("art:{}", a.id),
            RightTab::WorkspaceDiff => "diff:workspace".to_string(),
            RightTab::CustomNote { id, .. } => format!("note:{id}"),
        }
    }

    fn title(&self) -> String {
        match self {
            RightTab::Artifact(a) => a.title.clone(),
            RightTab::WorkspaceDiff => "Workspace Diff".to_string(),
            RightTab::CustomNote { title, .. } => title.clone(),
        }
    }
}

enum WorkerEvent {
    InitialState {
        auth: AuthStatusResponse,
        models: ModelsResponse,
        projects: Vec<ProjectRow>,
        sessions: Vec<SessionRow>,
    },
    SessionDetail(SessionDetailResponse),
    DiffLoaded(DiffResponse),
    DeviceStarted(Result<DeviceStartResponse, String>),
    DevicePolled(DevicePollResponse),
    AuthUpdated(Result<AuthStatusResponse, String>),
    ModelsUpdated(ModelsResponse),
    ProjectCreated(Result<ProjectRow, String>),
    SessionCreated(Result<SessionRow, String>),
    PromptError(String),
}

// ============================================================================
// Main Application State
// ============================================================================

struct EntryDesktopApp {
    sidecar_url: String,
    sidecar_child: Option<Child>,
    tx: Sender<WorkerEvent>,
    rx: Receiver<WorkerEvent>,

    // Layout state matching `three-column-workspace.html`
    show_left: bool,
    show_right: bool,
    full_right: bool,
    show_search: bool,
    search_query: String,

    // New Project Folder modal / input
    show_project_input: bool,
    project_path_input: String,
    selected_project_id: Option<String>,

    // Auth & Login Page state
    auth: AuthStatusResponse,
    auth_loading: bool,
    device_flow: Option<DeviceStartResponse>,
    device_status_text: Option<String>,
    device_expired: bool,
    auth_error: Option<String>,
    show_token_login: bool,
    manual_token_input: String,
    manual_email_input: String,

    // Live Models state
    models: Vec<LiveModel>,
    models_error: Option<String>,
    credit_gate: Option<CreditGateInfo>,
    selected_model_id: String,
    agent_mode: String, // "build" | "plan"

    // Projects & Conversations state
    projects: Vec<ProjectRow>,
    sessions: Vec<SessionRow>,
    active_session_id: Option<String>,
    active_detail: Option<SessionDetailResponse>,
    workspace_diff: DiffResponse,

    // Composer state
    composer_input: String,
    is_streaming: bool,
    active_lifecycle_state: String,
    prompt_error: Option<String>,
    scroll_to_bottom: bool,

    // Right Column Tabs state
    right_tabs: Vec<RightTab>,
    active_right_tab_id: Option<String>,
    untitled_counter: usize,

    // Polling timers
    last_poll: Instant,
    last_device_poll: Instant,
}

impl EntryDesktopApp {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        Self::configure_theme(&cc.egui_ctx);

        let port: u16 = std::env::var("ENTRY_SIDECAR_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(4096);
        let sidecar_url = format!("http://127.0.0.1:{port}");
        let sidecar_child = Self::ensure_sidecar_running(&sidecar_url, port);

        let (tx, rx) = mpsc::channel();
        let app = Self {
            sidecar_url,
            sidecar_child,
            tx,
            rx,
            show_left: true,
            show_right: true,
            full_right: false,
            show_search: false,
            search_query: String::new(),
            show_project_input: false,
            project_path_input: std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            selected_project_id: None,
            auth: AuthStatusResponse::default(),
            auth_loading: true,
            device_flow: None,
            device_status_text: None,
            device_expired: false,
            auth_error: None,
            show_token_login: false,
            manual_token_input: String::new(),
            manual_email_input: String::new(),
            models: Vec::new(),
            models_error: None,
            credit_gate: None,
            selected_model_id: String::new(),
            agent_mode: "build".to_string(),
            projects: Vec::new(),
            sessions: Vec::new(),
            active_session_id: None,
            active_detail: None,
            workspace_diff: DiffResponse::default(),
            composer_input: String::new(),
            is_streaming: false,
            active_lifecycle_state: "final_response".to_string(),
            prompt_error: None,
            scroll_to_bottom: false,
            right_tabs: Vec::new(),
            active_right_tab_id: None,
            untitled_counter: 0,
            last_poll: Instant::now() - Duration::from_secs(10),
            last_device_poll: Instant::now(),
        };

        app.refresh_all();
        app
    }

    fn configure_theme(ctx: &egui::Context) {
        let mut visuals = egui::Visuals::dark();
        visuals.panel_fill = BG;
        visuals.window_fill = BG_RAISE;
        visuals.extreme_bg_color = BG;
        visuals.faint_bg_color = BG_SIDE;
        visuals.code_bg_color = CODE_BG;
        visuals.override_text_color = Some(TEXT);
        visuals.selection.bg_fill = ACCENT.linear_multiply(0.35);
        visuals.selection.stroke = Stroke::new(1.0_f32, ACCENT);
        visuals.widgets.noninteractive.bg_fill = BG;
        visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, LINE);
        visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, TEXT);
        visuals.widgets.inactive.bg_fill = BG_RAISE;
        visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, LINE_STRONG);
        visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT_2);
        visuals.widgets.hovered.bg_fill = BG_HOVER;
        visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, LINE_STRONG);
        visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, TEXT);
        visuals.widgets.active.bg_fill = BG_ACTIVE;
        visuals.widgets.active.bg_stroke = Stroke::new(1.0_f32, ACCENT);
        visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, TEXT);
        ctx.set_visuals(visuals);
    }

    fn ensure_sidecar_running(sidecar_url: &str, port: u16) -> Option<Child> {
        let health_url = format!("{sidecar_url}/global/health");
        if ureq::AgentBuilder::new()
            .timeout(Duration::from_millis(350))
            .build()
            .get(&health_url)
            .call()
            .map(|r| r.status() == 200)
            .unwrap_or(false)
        {
            return None;
        }

        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(dir) = exe_path.parent() {
                let candidate = if cfg!(windows) {
                    dir.join("entry-agent-sidecar.exe")
                } else {
                    dir.join("entry-agent-sidecar")
                };
                if candidate.exists() {
                    if let Ok(child) = Command::new(candidate)
                        .arg("--port")
                        .arg(port.to_string())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                    {
                        thread::sleep(Duration::from_millis(450));
                        return Some(child);
                    }
                }
            }
        }

        if let Ok(child) = Command::new("bun")
            .arg("run")
            .arg("src/index.ts")
            .arg("--port")
            .arg(port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            thread::sleep(Duration::from_millis(550));
            return Some(child);
        }

        None
    }

    fn http_get<T: serde::de::DeserializeOwned>(url: &str, timeout_secs: u64) -> Result<T, String> {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(timeout_secs))
            .build();
        match agent.get(url).call() {
            Ok(resp) => resp.into_json::<T>().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, resp)) => {
                let body = resp.into_string().unwrap_or_default();
                Err(format!("HTTP {code}: {body}"))
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn http_post<T: serde::de::DeserializeOwned>(
        url: &str,
        body: serde_json::Value,
        timeout_secs: u64,
    ) -> Result<T, String> {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(timeout_secs))
            .build();
        match agent.post(url).send_json(body) {
            Ok(resp) => resp.into_json::<T>().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, resp)) => {
                let txt = resp.into_string().unwrap_or_default();
                Err(format!("HTTP {code}: {txt}"))
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn http_patch(url: &str, body: serde_json::Value) {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(5))
            .build();
        let _ = agent.request("PATCH", url).send_json(body);
    }

    fn refresh_all(&self) {
        let url = self.sidecar_url.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            let auth = Self::http_get::<AuthStatusResponse>(&format!("{url}/auth/status"), 6)
                .unwrap_or_default();
            let models =
                Self::http_get::<ModelsResponse>(&format!("{url}/models"), 6).unwrap_or_default();
            let projects = Self::http_get::<ProjectsResponse>(&format!("{url}/project"), 6)
                .map(|r| r.projects)
                .unwrap_or_default();
            let sessions = Self::http_get::<SessionsResponse>(&format!("{url}/session"), 6)
                .map(|r| r.sessions)
                .unwrap_or_default();

            let _ = tx.send(WorkerEvent::InitialState {
                auth,
                models,
                projects,
                sessions,
            });
        });
    }

    fn fetch_models(&self) {
        let url = self.sidecar_url.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            if let Ok(models) = Self::http_get::<ModelsResponse>(&format!("{url}/models"), 6) {
                let _ = tx.send(WorkerEvent::ModelsUpdated(models));
            }
        });
    }

    fn load_session(&self, session_id: &str) {
        let url = self.sidecar_url.clone();
        let sid = session_id.to_string();
        let tx = self.tx.clone();
        thread::spawn(move || {
            if let Ok(detail) =
                Self::http_get::<SessionDetailResponse>(&format!("{url}/session/{sid}"), 5)
            {
                let _ = tx.send(WorkerEvent::SessionDetail(detail));
            }
            if let Ok(diff) =
                Self::http_get::<DiffResponse>(&format!("{url}/session/{sid}/diff"), 5)
            {
                let _ = tx.send(WorkerEvent::DiffLoaded(diff));
            }
        });
    }

    fn start_device_login(&mut self) {
        self.auth_error = None;
        self.device_expired = false;
        self.device_status_text = Some("Requesting verification code from Entry...".to_string());
        let url = self.sidecar_url.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            match Self::http_post::<DeviceStartResponse>(
                &format!("{url}/auth/device/start"),
                serde_json::json!({}),
                8,
            ) {
                Ok(flow) => {
                    let _ = open::that(&flow.verification_uri_complete);
                    let _ = tx.send(WorkerEvent::DeviceStarted(Ok(flow)));
                }
                Err(e) => {
                    let _ = tx.send(WorkerEvent::DeviceStarted(Err(format!(
                        "Device authorization failed: {e}"
                    ))));
                }
            }
        });
    }

    fn poll_device_login(&self, device_code: &str) {
        let url = self.sidecar_url.clone();
        let code = device_code.to_string();
        let tx = self.tx.clone();
        thread::spawn(move || {
            if let Ok(poll) = Self::http_post::<DevicePollResponse>(
                &format!("{url}/auth/device/poll"),
                serde_json::json!({ "device_code": code }),
                5,
            ) {
                let _ = tx.send(WorkerEvent::DevicePolled(poll));
            }
        });
    }

    fn submit_manual_token(&mut self) {
        let token = self.manual_token_input.trim().to_string();
        if token.is_empty() {
            self.auth_error = Some("Please enter a valid Entry session token.".to_string());
            return;
        }
        let email = self.manual_email_input.trim().to_string();
        self.auth_error = None;
        self.auth_loading = true;
        let url = self.sidecar_url.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            match Self::http_post::<AuthStatusResponse>(
                &format!("{url}/auth/token"),
                serde_json::json!({
                    "token": token,
                    "email": if email.is_empty() { None } else { Some(email) }
                }),
                8,
            ) {
                Ok(status) => {
                    let _ = tx.send(WorkerEvent::AuthUpdated(Ok(status)));
                }
                Err(e) => {
                    let _ = tx.send(WorkerEvent::AuthUpdated(Err(format!(
                        "Authentication failed: {e}"
                    ))));
                }
            }
        });
    }

    fn sign_out(&mut self) {
        let url = self.sidecar_url.clone();
        let tx = self.tx.clone();
        self.device_flow = None;
        self.device_status_text = None;
        self.auth_error = None;
        thread::spawn(move || {
            let _ = Self::http_post::<serde_json::Value>(
                &format!("{url}/auth/logout"),
                serde_json::json!({}),
                5,
            );
            let _ = tx.send(WorkerEvent::AuthUpdated(Ok(AuthStatusResponse {
                authenticated: false,
                account: None,
                entry_base_url: None,
            })));
        });
    }

    fn create_project(&mut self, path_str: &str) {
        let trimmed = path_str.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        let url = self.sidecar_url.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            #[derive(Deserialize)]
            struct Wrap {
                project: ProjectRow,
            }
            match Self::http_post::<Wrap>(
                &format!("{url}/project"),
                serde_json::json!({ "worktree": trimmed }),
                6,
            ) {
                Ok(w) => {
                    let _ = tx.send(WorkerEvent::ProjectCreated(Ok(w.project)));
                }
                Err(e) => {
                    let _ = tx.send(WorkerEvent::ProjectCreated(Err(e)));
                }
            }
        });
    }

    fn create_new_conversation(&mut self) {
        self.prompt_error = None;
        let url = self.sidecar_url.clone();
        let tx = self.tx.clone();
        let model_id = if self.selected_model_id.is_empty() {
            None
        } else {
            Some(self.selected_model_id.clone())
        };
        let agent = self.agent_mode.clone();
        let project_id = self
            .selected_project_id
            .clone()
            .or_else(|| self.projects.first().map(|p| p.id.clone()));
        let fallback_dir = std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string());

        thread::spawn(move || {
            #[derive(Deserialize)]
            struct Wrap {
                session: SessionRow,
            }
            match Self::http_post::<Wrap>(
                &format!("{url}/session"),
                serde_json::json!({
                    "projectId": project_id,
                    "directory": if project_id.is_none() { fallback_dir } else { None },
                    "title": "New conversation",
                    "agent": agent,
                    "modelId": model_id,
                }),
                6,
            ) {
                Ok(w) => {
                    let _ = tx.send(WorkerEvent::SessionCreated(Ok(w.session)));
                }
                Err(e) => {
                    let _ = tx.send(WorkerEvent::SessionCreated(Err(e)));
                }
            }
        });
    }

    fn persist_selected_model_for_session(&self, model_id: &str) {
        let Some(sid) = self.active_session_id.clone() else {
            return;
        };
        let url = self.sidecar_url.clone();
        let mid = model_id.to_string();
        thread::spawn(move || {
            Self::http_patch(
                &format!("{url}/session/{sid}"),
                serde_json::json!({ "modelId": mid }),
            );
        });
    }

    fn send_prompt(&mut self) {
        let text = self.composer_input.trim().to_string();
        if text.is_empty() {
            return;
        }
        if self.selected_model_id.is_empty() {
            self.prompt_error = Some(
                "Please select an available AI model from the model menu before sending."
                    .to_string(),
            );
            return;
        }

        let Some(sid) = self.active_session_id.clone() else {
            self.prompt_error = Some(
                "Please create or select a conversation first (click '+ New Conversation')."
                    .to_string(),
            );
            return;
        };

        self.composer_input.clear();
        self.prompt_error = None;
        self.is_streaming = true;
        self.active_lifecycle_state = "thinking".to_string();
        self.scroll_to_bottom = true;

        let url = self.sidecar_url.clone();
        let agent = self.agent_mode.clone();
        let model_id = self.selected_model_id.clone();
        let tx = self.tx.clone();

        thread::spawn(move || {
            match Self::http_post::<SessionDetailResponse>(
                &format!("{url}/session/{sid}/message"),
                serde_json::json!({
                    "text": text,
                    "agent": agent,
                    "modelId": model_id,
                }),
                300,
            ) {
                Ok(detail) => {
                    let _ = tx.send(WorkerEvent::SessionDetail(detail));
                }
                Err(e) => {
                    let _ = tx.send(WorkerEvent::PromptError(e));
                }
            }
        });
    }

    fn abort_active_session(&mut self) {
        if let Some(sid) = self.active_session_id.clone() {
            let url = self.sidecar_url.clone();
            self.is_streaming = false;
            self.active_lifecycle_state = "final_response".to_string();
            thread::spawn(move || {
                let _ = Self::http_post::<serde_json::Value>(
                    &format!("{url}/session/{sid}/abort"),
                    serde_json::json!({}),
                    5,
                );
            });
        }
    }

    fn reply_permission(&self, perm_id: &str, approved: bool, scope: &str) {
        let url = self.sidecar_url.clone();
        let pid = perm_id.to_string();
        let sc = scope.to_string();
        let sid = self.active_session_id.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            let _ = Self::http_post::<serde_json::Value>(
                &format!("{url}/permission/{pid}/reply"),
                serde_json::json!({
                    "approved": approved,
                    "scope": sc,
                }),
                5,
            );
            if let Some(s) = sid {
                if let Ok(detail) =
                    Self::http_get::<SessionDetailResponse>(&format!("{url}/session/{s}"), 5)
                {
                    let _ = tx.send(WorkerEvent::SessionDetail(detail));
                }
            }
        });
    }

    fn sync_right_tabs(&mut self) {
        let mut new_tabs: Vec<RightTab> = Vec::new();
        if let Some(detail) = &self.active_detail {
            for art in &detail.artifacts {
                new_tabs.push(RightTab::Artifact(art.clone()));
            }
        }
        new_tabs.push(RightTab::WorkspaceDiff);

        for existing in &self.right_tabs {
            if matches!(existing, RightTab::CustomNote { .. }) {
                new_tabs.push(existing.clone());
            }
        }

        self.right_tabs = new_tabs;
        if self.active_right_tab_id.is_none()
            || !self
                .right_tabs
                .iter()
                .any(|t| Some(t.id()) == self.active_right_tab_id)
        {
            self.active_right_tab_id = self.right_tabs.first().map(|t| t.id());
        }
    }

    fn drain_events(&mut self) {
        while let Ok(ev) = self.rx.try_recv() {
            match ev {
                WorkerEvent::InitialState {
                    auth,
                    models,
                    projects,
                    sessions,
                } => {
                    self.auth = auth;
                    self.auth_loading = false;
                    self.models = models.models;
                    self.models_error = models.error;
                    self.credit_gate = models.credit_gate;
                    if self.selected_model_id.is_empty() {
                        if let Some(first) = self.models.first() {
                            self.selected_model_id = first.id.clone();
                        }
                    }
                    self.projects = projects;
                    if self.selected_project_id.is_none() {
                        self.selected_project_id = self.projects.first().map(|p| p.id.clone());
                    }
                    self.sessions = sessions;
                    if self.active_session_id.is_none() {
                        if let Some(first_sess) = self.sessions.first() {
                            let id = first_sess.id.clone();
                            self.active_session_id = Some(id.clone());
                            if let Some(m) = &first_sess.model_id {
                                if !m.is_empty() {
                                    self.selected_model_id = m.clone();
                                }
                            }
                            self.load_session(&id);
                        }
                    }
                    self.sync_right_tabs();
                }
                WorkerEvent::ModelsUpdated(m) => {
                    if !m.models.is_empty() {
                        self.models = m.models;
                    }
                    self.models_error = m.error;
                    self.credit_gate = m.credit_gate;
                    if self.selected_model_id.is_empty() {
                        if let Some(first) = self.models.first() {
                            self.selected_model_id = first.id.clone();
                        }
                    }
                }
                WorkerEvent::SessionDetail(detail) => {
                    let streaming = detail.messages.iter().any(|m| {
                        m.role == "assistant" && m.data.contains("\"status\":\"streaming\"")
                    });
                    self.is_streaming = streaming;

                    // Extract latest lifecycleState from last assistant message
                    if let Some(last_asst) =
                        detail.messages.iter().rev().find(|m| m.role == "assistant")
                    {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&last_asst.data) {
                            if let Some(st) = v.get("lifecycleState").and_then(|s| s.as_str()) {
                                self.active_lifecycle_state = st.to_string();
                            }
                        }
                    }

                    if let Some(mid) = &detail.session.model_id {
                        if !mid.is_empty() {
                            self.selected_model_id = mid.clone();
                        }
                    }
                    self.agent_mode = detail.session.agent.clone();

                    if let Some(slot) = self
                        .sessions
                        .iter_mut()
                        .find(|s| s.id == detail.session.id)
                    {
                        *slot = detail.session.clone();
                    } else {
                        self.sessions.insert(0, detail.session.clone());
                    }

                    self.active_detail = Some(detail);
                    self.sync_right_tabs();
                }
                WorkerEvent::DiffLoaded(diff) => {
                    self.workspace_diff = diff;
                }
                WorkerEvent::DeviceStarted(res) => match res {
                    Ok(flow) => {
                        self.device_status_text = Some(format!(
                            "Waiting for browser authorization at {}...",
                            flow.verification_uri
                        ));
                        self.device_flow = Some(flow);
                        self.device_expired = false;
                        self.auth_error = None;
                    }
                    Err(err) => {
                        self.auth_error = Some(err);
                        self.device_status_text = None;
                    }
                },
                WorkerEvent::DevicePolled(poll) => match poll.status.as_str() {
                    "approved" => {
                        self.auth.authenticated = true;
                        self.auth.account = poll.account;
                        self.device_flow = None;
                        self.device_status_text = None;
                        self.device_expired = false;
                        self.auth_error = None;
                        self.fetch_models();
                        self.refresh_all();
                    }
                    "expired" => {
                        self.device_expired = true;
                        self.device_status_text = None;
                        self.auth_error = Some(
                            poll.error.unwrap_or_else(|| {
                                "Authorization code expired. Please request a new code.".to_string()
                            }),
                        );
                    }
                    _ => {}
                },
                WorkerEvent::AuthUpdated(res) => {
                    self.auth_loading = false;
                    match res {
                        Ok(status) => {
                            self.auth = status;
                            self.auth_error = None;
                            self.manual_token_input.clear();
                            if self.auth.authenticated {
                                self.fetch_models();
                                self.refresh_all();
                            }
                        }
                        Err(err) => {
                            self.auth_error = Some(err);
                        }
                    }
                }
                WorkerEvent::ProjectCreated(res) => match res {
                    Ok(proj) => {
                        self.selected_project_id = Some(proj.id.clone());
                        self.show_project_input = false;
                        if !self.projects.iter().any(|p| p.id == proj.id) {
                            self.projects.insert(0, proj);
                        }
                    }
                    Err(err) => {
                        self.prompt_error = Some(format!("Failed to open project folder: {err}"));
                    }
                },
                WorkerEvent::SessionCreated(res) => match res {
                    Ok(sess) => {
                        let sid = sess.id.clone();
                        self.sessions.insert(0, sess);
                        self.active_session_id = Some(sid.clone());
                        self.load_session(&sid);
                    }
                    Err(err) => {
                        self.prompt_error = Some(format!("Could not create conversation: {err}"));
                    }
                },
                WorkerEvent::PromptError(err) => {
                    self.is_streaming = false;
                    self.active_lifecycle_state = "final_response".to_string();
                    if err.contains("HTTP 401") {
                        self.auth.authenticated = false;
                        self.auth.account = None;
                        self.auth_error = Some(
                            "Your session has expired. Please sign in again.".to_string(),
                        );
                    } else {
                        self.prompt_error = Some(err);
                    }
                }
            }
        }
    }

    // ========================================================================
    // Section 2: Native Desktop Login Screen
    // ========================================================================
    fn render_login_screen(&mut self, ctx: &egui::Context) {
        egui::CentralPanel::default()
            .frame(Frame::none().fill(BG))
            .show(ctx, |ui| {
                ui.vertical_centered(|ui| {
                    let available_h = ui.available_height();
                    ui.add_space((available_h * 0.14).max(32.0));

                    Frame::none()
                        .fill(BG_SIDE)
                        .stroke(Stroke::new(1.0_f32, LINE_STRONG))
                        .rounding(Rounding::same(12.0))
                        .inner_margin(Margin::symmetric(36.0, 32.0))
                        .show(ui, |ui| {
                            ui.set_max_width(440.0);
                            ui.set_min_width(380.0);

                            ui.vertical_centered(|ui| {
                                // Entry Pyramid Logo Badge
                                Frame::none()
                                    .fill(BG_RAISE)
                                    .stroke(Stroke::new(1.0_f32, LINE_STRONG))
                                    .rounding(Rounding::same(10.0))
                                    .inner_margin(Margin::symmetric(14.0, 10.0))
                                    .show(ui, |ui| {
                                        ui.label(
                                            RichText::new("▲")
                                                .size(24.0)
                                                .strong()
                                                .color(TEXT),
                                        );
                                    });

                                ui.add_space(14.0);
                                ui.label(
                                    RichText::new("Sign in to Entry Desktop")
                                        .size(21.0)
                                        .strong()
                                        .color(TEXT),
                                );
                                ui.add_space(4.0);
                                ui.label(
                                    RichText::new(
                                        "Connect your Entry account to access live models and run the coding agent on your local projects.",
                                    )
                                    .size(13.5)
                                    .color(TEXT_2),
                                );
                            });

                            ui.add_space(22.0);

                            // Error Banner if any
                            if let Some(err) = &self.auth_error {
                                Frame::none()
                                    .fill(RED.linear_multiply(0.14))
                                    .stroke(Stroke::new(1.0_f32, RED))
                                    .rounding(Rounding::same(8.0))
                                    .inner_margin(Margin::symmetric(12.0, 10.0))
                                    .show(ui, |ui| {
                                        ui.label(RichText::new(err).size(13.0).color(RED));
                                    });
                                ui.add_space(14.0);
                            }

                            // Active Device Authorization Flow Card
                            if let Some(flow) = self.device_flow.clone() {
                                Frame::none()
                                    .fill(BG_RAISE)
                                    .stroke(Stroke::new(1.0_f32, ACCENT))
                                    .rounding(Rounding::same(10.0))
                                    .inner_margin(Margin::symmetric(18.0, 16.0))
                                    .show(ui, |ui| {
                                        ui.vertical_centered(|ui| {
                                            ui.label(
                                                RichText::new("DEVICE AUTHORIZATION CODE")
                                                    .size(11.5)
                                                    .strong()
                                                    .color(TEXT_3),
                                            );
                                            ui.add_space(6.0);
                                            ui.label(
                                                RichText::new(&flow.code)
                                                    .font(FontId::new(28.0, FontFamily::Monospace))
                                                    .strong()
                                                    .color(ACCENT),
                                            );
                                            ui.add_space(8.0);
                                            ui.label(
                                                RichText::new(
                                                    "1. Confirm this 6-digit code in the browser tab that opened.\n2. Click Approve on entry-agents.dev to complete sign-in.",
                                                )
                                                .size(13.0)
                                                .color(TEXT_2),
                                            );
                                            ui.add_space(12.0);

                                            if !self.device_expired {
                                                ui.horizontal(|ui| {
                                                    ui.spinner();
                                                    ui.label(
                                                        RichText::new(
                                                            self.device_status_text
                                                                .as_deref()
                                                                .unwrap_or(
                                                                    "Waiting for approval...",
                                                                ),
                                                        )
                                                        .size(12.5)
                                                        .color(TEXT_2),
                                                    );
                                                });
                                            }

                                            ui.add_space(10.0);
                                            ui.horizontal(|ui| {
                                                if ui
                                                    .button(
                                                        RichText::new("Re-open Browser")
                                                            .size(13.0)
                                                            .color(ACCENT),
                                                    )
                                                    .clicked()
                                                {
                                                    let _ =
                                                        open::that(&flow.verification_uri_complete);
                                                }
                                                if ui
                                                    .button(
                                                        RichText::new("Copy Verification Link")
                                                            .size(13.0)
                                                            .color(TEXT_2),
                                                    )
                                                    .clicked()
                                                {
                                                    ctx.copy_text(
                                                        flow.verification_uri_complete.clone(),
                                                    );
                                                }
                                                if ui
                                                    .button(
                                                        RichText::new("Request New Code")
                                                            .size(13.0)
                                                            .color(TEXT_2),
                                                    )
                                                    .clicked()
                                                {
                                                    self.start_device_login();
                                                }
                                            });
                                        });
                                    });
                            } else {
                                // Primary Sign-In Button
                                let sign_in_btn = egui::Button::new(
                                    RichText::new("Sign in with Entry Account")
                                        .size(15.0)
                                        .strong()
                                        .color(Color32::WHITE),
                                )
                                .fill(ACCENT)
                                .min_size(Vec2::new(ui.available_width(), 42.0))
                                .rounding(Rounding::same(8.0));

                                if ui.add(sign_in_btn).clicked() {
                                    self.start_device_login();
                                }
                            }

                            ui.add_space(18.0);
                            ui.separator();
                            ui.add_space(10.0);

                            // Expandable Session Token Sign-in (for headless/CLI or direct account token)
                            let toggle_label = if self.show_token_login {
                                "▾ Sign in with an existing Entry session token"
                            } else {
                                "▸ Sign in with an existing Entry session token"
                            };
                            if ui
                                .add(
                                    egui::Button::new(
                                        RichText::new(toggle_label).size(12.5).color(TEXT_3),
                                    )
                                    .frame(false),
                                )
                                .clicked()
                            {
                                self.show_token_login = !self.show_token_login;
                            }

                            if self.show_token_login {
                                ui.add_space(8.0);
                                ui.label(
                                    RichText::new("Account Email (optional)")
                                        .size(12.0)
                                        .color(TEXT_3),
                                );
                                ui.add(
                                    TextEdit::singleline(&mut self.manual_email_input)
                                        .hint_text("you@company.com")
                                        .desired_width(f32::INFINITY),
                                );
                                ui.add_space(6.0);
                                ui.label(
                                    RichText::new("Session Token")
                                        .size(12.0)
                                        .color(TEXT_3),
                                );
                                ui.add(
                                    TextEdit::singleline(&mut self.manual_token_input)
                                        .password(true)
                                        .hint_text("Paste your Entry session token")
                                        .desired_width(f32::INFINITY),
                                );
                                ui.add_space(10.0);
                                let token_btn = egui::Button::new(
                                    RichText::new("Verify & Sign In")
                                        .size(13.5)
                                        .color(TEXT),
                                )
                                .fill(BG_RAISE)
                                .stroke(Stroke::new(1.0_f32, LINE_STRONG))
                                .min_size(Vec2::new(ui.available_width(), 34.0))
                                .rounding(Rounding::same(6.0));

                                if ui.add(token_btn).clicked() {
                                    self.submit_manual_token();
                                }
                            }
                        });
                });
            });
    }

    // ========================================================================
    // Column 1: Left Navigation Sidebar (`--lw: 335px`, `--bg-side: #1b1b1b`)
    // ========================================================================
    fn render_left_column(&mut self, ui: &mut egui::Ui) {
        ui.vertical(|ui| {
            // Top bar (`height: 46px`)
            Frame::none()
                .inner_margin(Margin::symmetric(10.0, 8.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("▲").size(19.0).strong().color(TEXT));
                        ui.add_space(4.0);
                        if Self::icon_btn(ui, "◧", "Hide sidebar", true).clicked() {
                            self.show_left = false;
                        }
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if Self::icon_btn(ui, "⌕", "Search conversations", true).clicked() {
                                self.show_search = !self.show_search;
                                if !self.show_search {
                                    self.search_query.clear();
                                }
                            }
                        });
                    });
                });

            // `+ New Conversation` button
            Frame::none()
                .inner_margin(Margin::symmetric(8.0, 4.0))
                .show(ui, |ui| {
                    let btn = egui::Button::new(
                        RichText::new("+   New Conversation")
                            .size(14.5)
                            .color(TEXT),
                    )
                    .fill(Color32::from_rgb(0x20, 0x20, 0x20))
                    .stroke(Stroke::new(1.0_f32, LINE_STRONG))
                    .rounding(Rounding::same(6.0))
                    .min_size(Vec2::new(ui.available_width(), 36.0));
                    if ui.add(btn).clicked() {
                        self.create_new_conversation();
                    }
                });

            // Section: Projects
            Frame::none()
                .inner_margin(Margin {
                    left: 16.0,
                    right: 8.0,
                    top: 12.0,
                    bottom: 4.0,
                })
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new("Projects")
                                .size(13.0)
                                .strong()
                                .color(TEXT_3),
                        );
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if Self::icon_btn(ui, "+", "Open project folder", true).clicked() {
                                if let Some(picked) = rfd::FileDialog::new().pick_folder() {
                                    let p = picked.to_string_lossy().to_string();
                                    self.project_path_input = p.clone();
                                    self.create_project(&p);
                                } else {
                                    self.show_project_input = !self.show_project_input;
                                }
                            }
                        });
                    });
                });

            if self.show_project_input {
                Frame::none()
                    .inner_margin(Margin::symmetric(12.0, 4.0))
                    .show(ui, |ui| {
                        ui.label(
                            RichText::new("Local project folder path:")
                                .size(12.0)
                                .color(TEXT_3),
                        );
                        let resp = ui.add(
                            TextEdit::singleline(&mut self.project_path_input)
                                .hint_text("C:\\path\\to\\project or /path/to/project")
                                .desired_width(f32::INFINITY),
                        );
                        if resp.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
                            let path = self.project_path_input.clone();
                            self.create_project(&path);
                        }
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            if ui
                                .button(RichText::new("Open Folder").size(12.5).color(ACCENT))
                                .clicked()
                            {
                                let path = self.project_path_input.clone();
                                self.create_project(&path);
                            }
                            if ui
                                .button(RichText::new("Cancel").size(12.5).color(TEXT_3))
                                .clicked()
                            {
                                self.show_project_input = false;
                            }
                        });
                    });
            }

            if self.projects.is_empty() {
                Frame::none()
                    .inner_margin(Margin::symmetric(16.0, 4.0))
                    .show(ui, |ui| {
                        ui.label(RichText::new("No projects yet").size(13.0).color(TEXT_3));
                    });
            } else {
                Frame::none()
                    .inner_margin(Margin::symmetric(8.0, 2.0))
                    .show(ui, |ui| {
                        for p in self.projects.clone() {
                            let is_selected = self.selected_project_id.as_deref() == Some(&p.id);
                            let fill = if is_selected {
                                BG_ACTIVE
                            } else {
                                Color32::TRANSPARENT
                            };
                            let text_col = if is_selected { TEXT } else { TEXT_2 };
                            let branch = p.branch.as_deref().unwrap_or("local");
                            let btn = egui::Button::new(
                                RichText::new(format!("📁  {} ({})", p.name, branch))
                                    .size(13.5)
                                    .color(text_col),
                            )
                            .fill(fill)
                            .frame(is_selected)
                            .rounding(Rounding::same(6.0))
                            .min_size(Vec2::new(ui.available_width(), 30.0));
                            if ui.add(btn).on_hover_text(&p.worktree).clicked() {
                                self.selected_project_id = Some(p.id.clone());
                            }
                        }
                    });
            }

            // Section: Conversations
            Frame::none()
                .inner_margin(Margin {
                    left: 16.0,
                    right: 8.0,
                    top: 12.0,
                    bottom: 4.0,
                })
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new("Conversations")
                                .size(13.0)
                                .strong()
                                .color(TEXT_3),
                        );
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if Self::icon_btn(ui, "+", "New conversation", true).clicked() {
                                self.create_new_conversation();
                            }
                        });
                    });
                });

            if self.show_search {
                Frame::none()
                    .inner_margin(Margin::symmetric(8.0, 4.0))
                    .show(ui, |ui| {
                        ui.add(
                            TextEdit::singleline(&mut self.search_query)
                                .hint_text("Filter conversations")
                                .desired_width(f32::INFINITY),
                        );
                    });
            }

            // Scrollable conversations list + Account footer
            let footer_h = 62.0;
            let list_h = (ui.available_height() - footer_h).max(80.0);
            ui.allocate_ui(Vec2::new(ui.available_width(), list_h), |ui| {
                ScrollArea::vertical()
                    .id_salt("left_convs_scroll")
                    .show(ui, |ui| {
                        Frame::none()
                            .inner_margin(Margin::symmetric(8.0, 2.0))
                            .show(ui, |ui| {
                                let q = self.search_query.trim().to_lowercase();
                                let filtered: Vec<SessionRow> = self
                                    .sessions
                                    .iter()
                                    .filter(|s| q.is_empty() || s.title.to_lowercase().contains(&q))
                                    .cloned()
                                    .collect();

                                if filtered.is_empty() {
                                    ui.add_space(6.0);
                                    ui.label(
                                        RichText::new("No conversations yet")
                                            .size(13.0)
                                            .color(TEXT_3),
                                    );
                                }

                                for sess in filtered {
                                    let is_active =
                                        self.active_session_id.as_deref() == Some(&sess.id);
                                    let fill = if is_active {
                                        BG_ACTIVE
                                    } else {
                                        Color32::TRANSPARENT
                                    };
                                    let text_col = if is_active { TEXT } else { TEXT_2 };

                                    Frame::none()
                                        .fill(fill)
                                        .rounding(Rounding::same(6.0))
                                        .inner_margin(Margin::symmetric(10.0, 7.0))
                                        .show(ui, |ui| {
                                            let resp = ui
                                                .horizontal(|ui| {
                                                    let title_t = if sess.title.chars().count() > 28
                                                    {
                                                        let s: String =
                                                            sess.title.chars().take(28).collect();
                                                        format!("{s}…")
                                                    } else {
                                                        sess.title.clone()
                                                    };
                                                    ui.label(
                                                        RichText::new(title_t)
                                                            .size(14.0)
                                                            .color(text_col),
                                                    );
                                                    ui.with_layout(
                                                        Layout::right_to_left(Align::Center),
                                                        |ui| {
                                                            ui.label(
                                                                RichText::new(&sess.agent)
                                                                    .size(11.5)
                                                                    .color(TEXT_3),
                                                            );
                                                        },
                                                    );
                                                })
                                                .response
                                                .interact(Sense::click());

                                            if resp.clicked() {
                                                let sid = sess.id.clone();
                                                self.active_session_id = Some(sid.clone());
                                                self.prompt_error = None;
                                                self.load_session(&sid);
                                            }
                                        });
                                }
                            });
                    });
            });

            // Footer: Signed-in Account Info & Sign Out button
            let rect = ui.available_rect_before_wrap();
            ui.painter().hline(
                rect.x_range(),
                rect.top(),
                Stroke::new(1.0_f32, LINE),
            );
            Frame::none()
                .inner_margin(Margin::symmetric(12.0, 8.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let email = self
                            .auth
                            .account
                            .as_ref()
                            .map(|a| a.email.as_str())
                            .unwrap_or("Account");
                        let plan = self
                            .auth
                            .account
                            .as_ref()
                            .and_then(|a| a.plan_name.as_deref())
                            .unwrap_or("Entry");
                        let credits = self
                            .auth
                            .account
                            .as_ref()
                            .and_then(|a| a.credit_balance_cents)
                            .unwrap_or(0);

                        ui.vertical(|ui| {
                            ui.label(RichText::new(email).size(13.0).color(TEXT));
                            ui.label(
                                RichText::new(format!(
                                    "{plan} · ${:.2}",
                                    credits as f64 / 100.0
                                ))
                                .size(11.5)
                                .color(TEXT_3),
                            );
                        });

                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if ui
                                .button(RichText::new("Sign Out").size(12.5).color(TEXT_2))
                                .clicked()
                            {
                                self.sign_out();
                            }
                        });
                    });
                });
        });
    }

    // ========================================================================
    // Column 2: Center Chat & Real-Time Tool Lifecycle Thread (`1fr`, `--bg: #141414`)
    // ========================================================================
    fn render_center_column(&mut self, ui: &mut egui::Ui) {
        ui.vertical(|ui| {
            // Top bar (`46px`)
            Frame::none()
                .inner_margin(Margin::symmetric(14.0, 8.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        if !self.show_left {
                            if Self::icon_btn(ui, "◧", "Show sidebar", true).clicked() {
                                self.show_left = true;
                            }
                        }

                        let title = self
                            .active_detail
                            .as_ref()
                            .map(|d| d.session.title.as_str())
                            .unwrap_or("New conversation");
                        ui.label(RichText::new(title).size(15.0).color(TEXT_2));

                        if let Some(detail) = &self.active_detail {
                            ui.add_space(8.0);
                            Frame::none()
                                .fill(BG_RAISE)
                                .stroke(Stroke::new(1.0_f32, LINE))
                                .rounding(Rounding::same(4.0))
                                .inner_margin(Margin::symmetric(6.0, 2.0))
                                .show(ui, |ui| {
                                    ui.label(
                                        RichText::new(&detail.session.directory)
                                            .font(FontId::new(11.5, FontFamily::Monospace))
                                            .color(TEXT_3),
                                    );
                                });
                        }

                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if !self.show_right {
                                if Self::icon_btn(ui, "◨", "Show artifact panel", true).clicked() {
                                    self.show_right = true;
                                }
                            }
                        });
                    });
                });

            // Pending Permission Approval Banner (Section 4 & Section 6)
            let pending_perms = self
                .active_detail
                .as_ref()
                .map(|d| d.permissions.clone())
                .unwrap_or_default();

            for perm in pending_perms {
                Frame::none()
                    .fill(AMBER.linear_multiply(0.14))
                    .stroke(Stroke::new(1.0_f32, AMBER))
                    .rounding(Rounding::same(8.0))
                    .inner_margin(Margin::symmetric(14.0, 10.0))
                    .outer_margin(Margin::symmetric(18.0, 4.0))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(
                                RichText::new(format!(
                                    "⚠ Waiting for permission: {} wants to access `{}`",
                                    perm.tool_name, perm.target
                                ))
                                .size(13.5)
                                .strong()
                                .color(AMBER),
                            );
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if ui
                                    .button(RichText::new("Deny").size(12.5).color(RED))
                                    .clicked()
                                {
                                    self.reply_permission(&perm.id, false, "once");
                                }
                                if ui
                                    .button(
                                        RichText::new("Approve for Session")
                                            .size(12.5)
                                            .color(GREEN),
                                    )
                                    .clicked()
                                {
                                    self.reply_permission(&perm.id, true, "session");
                                }
                                if ui
                                    .button(
                                        RichText::new("Approve Once")
                                            .size(12.5)
                                            .strong()
                                            .color(GREEN),
                                    )
                                    .clicked()
                                {
                                    self.reply_permission(&perm.id, true, "once");
                                }
                            });
                        });
                    });
            }

            // Error Banner (Credit gate, network error, model unavailable, etc.)
            if let Some(err) = self.prompt_error.clone() {
                Frame::none()
                    .fill(RED.linear_multiply(0.14))
                    .stroke(Stroke::new(1.0_f32, RED))
                    .rounding(Rounding::same(8.0))
                    .inner_margin(Margin::symmetric(14.0, 10.0))
                    .outer_margin(Margin::symmetric(18.0, 4.0))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(&err).size(13.0).color(RED));
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if ui
                                    .button(RichText::new("Dismiss").size(12.0).color(TEXT_2))
                                    .clicked()
                                {
                                    self.prompt_error = None;
                                }
                            });
                        });
                    });
            }

            // Message Thread (`flex: 1`)
            let composer_h = 128.0;
            let thread_h = (ui.available_height() - composer_h).max(120.0);

            ui.allocate_ui(Vec2::new(ui.available_width(), thread_h), |ui| {
                ScrollArea::vertical()
                    .id_salt("center_thread_scroll")
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.vertical_centered(|ui| {
                            ui.set_max_width(760.0);
                            Frame::none()
                                .inner_margin(Margin::symmetric(18.0, 10.0))
                                .show(ui, |ui| {
                                    let messages = self
                                        .active_detail
                                        .as_ref()
                                        .map(|d| d.messages.clone())
                                        .unwrap_or_default();

                                    if messages.is_empty() {
                                        // Exact genuine empty state from `three-column-workspace.html`
                                        ui.add_space(thread_h * 0.28);
                                        ui.vertical_centered(|ui| {
                                            ui.label(
                                                RichText::new("New conversation")
                                                    .size(17.0)
                                                    .color(TEXT_2),
                                            );
                                            ui.add_space(4.0);
                                            ui.label(
                                                RichText::new(
                                                    "Describe what you want the agent to build or fix.",
                                                )
                                                .size(14.5)
                                                .color(TEXT_3),
                                            );
                                        });
                                        return;
                                    }

                                    for (idx, msg) in messages.iter().enumerate() {
                                        if msg.role == "user" {
                                            let user_text = Self::extract_message_text(msg);
                                            Frame::none()
                                                .fill(Color32::from_rgb(0x1f, 0x1f, 0x1f))
                                                .stroke(Stroke::new(1.0_f32, LINE_STRONG))
                                                .rounding(Rounding::same(10.0))
                                                .inner_margin(Margin::symmetric(14.0, 11.0))
                                                .show(ui, |ui| {
                                                    ui.set_min_width(ui.available_width());
                                                    ui.label(
                                                        RichText::new(user_text)
                                                            .size(15.0)
                                                            .color(TEXT),
                                                    );
                                                });
                                            ui.add_space(12.0);
                                        } else if msg.role == "assistant" {
                                            // Render tool call lifecycle cards in order
                                            for part in &msg.parts {
                                                if part.part_type == "tool" {
                                                    self.render_tool_part_card(ui, part);
                                                    ui.add_space(6.0);
                                                }
                                            }

                                            // Render assistant markdown text
                                            let asst_text = Self::extract_message_text(msg);
                                            if !asst_text.trim().is_empty() {
                                                Self::render_markdown_block(ui, &asst_text);
                                            }

                                            // If this is the active assistant turn, show distinct lifecycle state badge
                                            if idx + 1 == messages.len() && self.is_streaming {
                                                ui.add_space(6.0);
                                                self.render_lifecycle_status_badge(ui);
                                            }

                                            ui.add_space(16.0);
                                        }
                                    }

                                    if self.scroll_to_bottom {
                                        ui.scroll_to_cursor(Some(Align::BOTTOM));
                                        self.scroll_to_bottom = false;
                                    }
                                });
                        });
                    });
            });

            // Bottom Composer Box (`max-width: 792px`, `--bg-side: #1b1b1b`, `border-radius: 12px`)
            ui.vertical_centered(|ui| {
                ui.set_max_width(792.0);
                Frame::none()
                    .inner_margin(Margin::symmetric(16.0, 8.0))
                    .show(ui, |ui| {
                        Frame::none()
                            .fill(BG_SIDE)
                            .stroke(Stroke::new(1.0_f32, LINE_STRONG))
                            .rounding(Rounding::same(12.0))
                            .inner_margin(Margin::symmetric(14.0, 11.0))
                            .show(ui, |ui| {
                                let te = TextEdit::multiline(&mut self.composer_input)
                                    .hint_text("Ask the agent anything")
                                    .frame(false)
                                    .desired_rows(2)
                                    .desired_width(f32::INFINITY);
                                let resp = ui.add(te);

                                if resp.has_focus()
                                    && ui.input(|i| i.key_pressed(Key::Enter) && !i.modifiers.shift)
                                {
                                    self.send_prompt();
                                }

                                ui.add_space(8.0);
                                ui.horizontal(|ui| {
                                    // Live Model Selector Menu (`Section 3`)
                                    let current_model_label = self
                                        .models
                                        .iter()
                                        .find(|m| m.id == self.selected_model_id)
                                        .map(|m| m.name.clone())
                                        .unwrap_or_else(|| {
                                            if self.selected_model_id.is_empty() {
                                                "Select live model".to_string()
                                            } else {
                                                self.selected_model_id.clone()
                                            }
                                        });

                                    egui::ComboBox::from_id_salt(Id::new("live_model_selector"))
                                        .selected_text(
                                            RichText::new(format!("{current_model_label} ▴"))
                                                .size(13.5)
                                                .color(TEXT_2),
                                        )
                                        .width(240.0)
                                        .show_ui(ui, |ui| {
                                            if self.models.is_empty() {
                                                ui.label(
                                                    RichText::new(
                                                        self.models_error.as_deref().unwrap_or(
                                                            "No live models loaded yet",
                                                        ),
                                                    )
                                                    .size(12.5)
                                                    .color(TEXT_3),
                                                );
                                            }
                                            for m in self.models.clone() {
                                                let ctx_info = m
                                                    .context_window
                                                    .map(|c| format!(" ({}k ctx)", c / 1000))
                                                    .unwrap_or_default();
                                                let label =
                                                    format!("{} · {}{}", m.name, m.chef, ctx_info);
                                                if ui
                                                    .selectable_label(
                                                        self.selected_model_id == m.id,
                                                        label,
                                                    )
                                                    .clicked()
                                                {
                                                    self.selected_model_id = m.id.clone();
                                                    self.persist_selected_model_for_session(&m.id);
                                                }
                                            }
                                        });

                                    // Agent Mode Switch (`Build` vs `Plan`)
                                    let is_plan = self.agent_mode == "plan";
                                    let mode_text = if is_plan {
                                        "Mode: Plan"
                                    } else {
                                        "Mode: Build"
                                    };
                                    let mode_col = if is_plan { ACCENT } else { TEXT_2 };
                                    if ui
                                        .add(
                                            egui::Button::new(
                                                RichText::new(mode_text)
                                                    .size(13.0)
                                                    .color(mode_col),
                                            )
                                            .fill(Color32::TRANSPARENT),
                                        )
                                        .on_hover_text(
                                            "Switch between Build (full tool execution) and Plan (read-only exploration + plan file)",
                                        )
                                        .clicked()
                                    {
                                        self.agent_mode = if is_plan {
                                            "build".to_string()
                                        } else {
                                            "plan".to_string()
                                        };
                                    }

                                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                        if self.is_streaming {
                                            let stop_btn = egui::Button::new(
                                                RichText::new("■ Stop")
                                                    .size(13.0)
                                                    .strong()
                                                    .color(Color32::WHITE),
                                            )
                                            .fill(RED)
                                            .rounding(Rounding::same(16.0))
                                            .min_size(Vec2::new(68.0, 32.0));
                                            if ui.add(stop_btn).clicked() {
                                                self.abort_active_session();
                                            }
                                        } else {
                                            let send_btn = egui::Button::new(
                                                RichText::new("→")
                                                    .size(16.0)
                                                    .strong()
                                                    .color(Color32::WHITE),
                                            )
                                            .fill(ACCENT)
                                            .rounding(Rounding::same(16.0))
                                            .min_size(Vec2::new(32.0, 32.0));
                                            if ui.add(send_btn).on_hover_text("Send").clicked() {
                                                self.send_prompt();
                                            }
                                        }
                                    });
                                });
                            });
                    });
            });
        });
    }

    // ========================================================================
    // Tool Call Card Renderer (Distinguishes all required Section 4 states)
    // ========================================================================
    fn render_tool_part_card(&self, ui: &mut egui::Ui, part: &PartRow) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&part.data) else {
            return;
        };
        let tool_name = v
            .get("tool")
            .and_then(|s| s.as_str())
            .unwrap_or("tool");
        let title = v
            .get("title")
            .and_then(|s| s.as_str())
            .unwrap_or(tool_name);
        let state = v
            .get("state")
            .or_else(|| v.get("status"))
            .and_then(|s| s.as_str())
            .unwrap_or("tool_executing");
        let input_str = v
            .get("input")
            .map(|i| {
                if let Some(s) = i.as_str() {
                    s.to_string()
                } else {
                    serde_json::to_string(i).unwrap_or_default()
                }
            })
            .unwrap_or_default();
        let output_str = v
            .get("output")
            .and_then(|s| s.as_str())
            .unwrap_or("");

        let (badge_label, badge_color) = match state {
            "tool_requested" | "requested" => ("Tool requested", ACCENT),
            "waiting_permission" => ("Waiting for permission", AMBER),
            "tool_executing" | "running" => ("Tool executing", ACCENT),
            "tool_completed" | "completed" => ("Tool completed", GREEN),
            "tool_failed" | "error" => ("Tool failed", RED),
            _ => (state, TEXT_3),
        };

        Frame::none()
            .fill(CODE_BG)
            .stroke(Stroke::new(1.0_f32, LINE_STRONG))
            .rounding(Rounding::same(8.0))
            .inner_margin(Margin::symmetric(12.0, 9.0))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(format!("⚙ {title}"))
                            .font(FontId::new(13.0, FontFamily::Monospace))
                            .strong()
                            .color(TEXT),
                    );
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(
                            RichText::new(badge_label)
                                .size(12.0)
                                .strong()
                                .color(badge_color),
                        );
                    });
                });

                if !input_str.is_empty() && input_str != "{}" {
                    let preview: String = input_str.chars().take(180).collect();
                    ui.add_space(3.0);
                    ui.label(
                        RichText::new(format!("args: {preview}"))
                            .font(FontId::new(11.5, FontFamily::Monospace))
                            .color(TEXT_3),
                    );
                }

                if !output_str.is_empty() {
                    ui.add_space(4.0);
                    egui::CollapsingHeader::new(
                        RichText::new("View tool output")
                            .size(12.0)
                            .color(TEXT_2),
                    )
                    .id_salt(format!("tool_out_{}", part.id))
                    .default_open(state == "tool_failed" || state == "error")
                    .show(ui, |ui| {
                        let snippet: String = output_str.chars().take(2400).collect();
                        ui.label(
                            RichText::new(snippet)
                                .font(FontId::new(12.0, FontFamily::Monospace))
                                .color(if state == "tool_failed" || state == "error" {
                                    RED
                                } else {
                                    TEXT_2
                                }),
                        );
                    });
                }
            });
    }

    fn render_lifecycle_status_badge(&self, ui: &mut egui::Ui) {
        let (label, col) = match self.active_lifecycle_state.as_str() {
            "thinking" => ("Thinking...", ACCENT),
            "tool_requested" => ("Tool requested...", ACCENT),
            "waiting_permission" => ("Waiting for user permission approval...", AMBER),
            "tool_executing" => ("Tool executing on local project...", ACCENT),
            "tool_completed" => ("Tool completed — synthesizing response...", GREEN),
            "tool_failed" => ("Tool failed — reporting to model...", RED),
            _ => ("Working...", ACCENT),
        };
        ui.horizontal(|ui| {
            ui.spinner();
            ui.label(RichText::new(label).size(13.0).color(col));
        });
    }

    // ========================================================================
    // Column 3: Right Artifact & Diff Panel (`--rw: 560px`, `--bg-panel: #181818`)
    // ========================================================================
    fn render_right_column(&mut self, ui: &mut egui::Ui) {
        ui.vertical(|ui| {
            // Top tab bar (`height: 46px`)
            Frame::none()
                .inner_margin(Margin::symmetric(8.0, 6.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let tabs_snapshot = self.right_tabs.clone();
                        for tab in &tabs_snapshot {
                            let id = tab.id();
                            let is_active = self.active_right_tab_id.as_ref() == Some(&id);
                            let fill = if is_active {
                                BG_RAISE
                            } else {
                                Color32::TRANSPARENT
                            };
                            let fg = if is_active { TEXT } else { TEXT_3 };

                            Frame::none()
                                .fill(fill)
                                .rounding(Rounding::same(6.0))
                                .inner_margin(Margin::symmetric(10.0, 5.0))
                                .show(ui, |ui| {
                                    ui.horizontal(|ui| {
                                        if ui
                                            .add(
                                                egui::Button::new(
                                                    RichText::new(tab.title()).size(13.5).color(fg),
                                                )
                                                .frame(false),
                                            )
                                            .clicked()
                                        {
                                            self.active_right_tab_id = Some(id.clone());
                                        }
                                        if self.right_tabs.len() > 1 {
                                            if ui
                                                .add(
                                                    egui::Button::new(
                                                        RichText::new("×").size(13.0).color(TEXT_3),
                                                    )
                                                    .frame(false),
                                                )
                                                .on_hover_text("Close tab")
                                                .clicked()
                                            {
                                                self.right_tabs.retain(|t| t.id() != id);
                                                if self.active_right_tab_id.as_ref() == Some(&id) {
                                                    self.active_right_tab_id =
                                                        self.right_tabs.first().map(|t| t.id());
                                                }
                                            }
                                        }
                                    });
                                });
                        }

                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if Self::icon_btn(ui, "◨", "Hide panel", true).clicked() {
                                self.show_right = false;
                                self.full_right = false;
                            }
                            let expand_lbl = if self.full_right { "Restore panel" } else { "Expand panel" };
                            if Self::icon_btn(ui, "⤢", expand_lbl, true).clicked() {
                                self.full_right = !self.full_right;
                            }
                            if Self::icon_btn(ui, "+", "New tab", true).clicked() {
                                self.untitled_counter += 1;
                                let id = format!("untitled_{}", self.untitled_counter);
                                let tab = RightTab::CustomNote {
                                    id: id.clone(),
                                    title: "Untitled artifact".to_string(),
                                    content: String::new(),
                                };
                                let full_id = tab.id();
                                self.right_tabs.push(tab);
                                self.active_right_tab_id = Some(full_id);
                            }
                        });
                    });
                });

            // Subbar (`height: 42px`, `border-bottom: 1px solid var(--line)`)
            let rect = ui.available_rect_before_wrap();
            ui.painter()
                .hline(rect.x_range(), rect.top(), Stroke::new(1.0_f32, LINE));
            Frame::none()
                .inner_margin(Margin::symmetric(16.0, 8.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Artifact").size(13.5).color(TEXT_2));
                        if self.workspace_diff.files > 0 {
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                ui.label(
                                    RichText::new(format!(
                                        "{} files  +{}  -{}",
                                        self.workspace_diff.files,
                                        self.workspace_diff.additions,
                                        self.workspace_diff.deletions
                                    ))
                                    .font(FontId::new(12.0, FontFamily::Monospace))
                                    .color(TEXT_3),
                                );
                            });
                        }
                    });
                });
            let rect2 = ui.available_rect_before_wrap();
            ui.painter()
                .hline(rect2.x_range(), rect2.top(), Stroke::new(1.0_f32, LINE));

            // Document body
            ScrollArea::vertical()
                .id_salt("right_doc_scroll")
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    Frame::none()
                        .inner_margin(Margin::symmetric(18.0, 20.0))
                        .show(ui, |ui| {
                            let active = self
                                .right_tabs
                                .iter()
                                .find(|t| Some(t.id()) == self.active_right_tab_id)
                                .cloned();

                            match active {
                                Some(RightTab::Artifact(art)) => {
                                    ui.label(
                                        RichText::new(&art.title)
                                            .size(20.0)
                                            .strong()
                                            .color(TEXT),
                                    );
                                    ui.add_space(10.0);
                                    Self::render_markdown_block(ui, &art.content);
                                }
                                Some(RightTab::WorkspaceDiff) => {
                                    if self.workspace_diff.diff.trim().is_empty() {
                                        Self::render_doc_empty(ui, "Nothing here yet");
                                    } else {
                                        ui.label(
                                            RichText::new("Workspace Git Diff")
                                                .size(19.0)
                                                .strong()
                                                .color(TEXT),
                                        );
                                        ui.add_space(10.0);
                                        Self::render_diff_lines(ui, &self.workspace_diff.diff);
                                    }
                                }
                                Some(RightTab::CustomNote { content, .. }) => {
                                    if content.trim().is_empty() {
                                        Self::render_doc_empty(ui, "Nothing here yet");
                                    } else {
                                        Self::render_markdown_block(ui, &content);
                                    }
                                }
                                None => {
                                    Self::render_doc_empty(ui, "No artifacts open");
                                }
                            }
                        });
                });
        });
    }

    fn render_doc_empty(ui: &mut egui::Ui, heading: &str) {
        ui.add_space(120.0);
        ui.vertical_centered(|ui| {
            ui.label(RichText::new(heading).size(17.0).color(TEXT_2));
            ui.add_space(4.0);
            ui.label(
                RichText::new("Documents and diffs the agent writes appear in this panel.")
                    .size(14.0)
                    .color(TEXT_3),
            );
        });
    }

    fn render_diff_lines(ui: &mut egui::Ui, diff: &str) {
        Frame::none()
            .fill(CODE_BG)
            .stroke(Stroke::new(1.0_f32, LINE))
            .rounding(Rounding::same(6.0))
            .inner_margin(Margin::symmetric(12.0, 10.0))
            .show(ui, |ui| {
                for line in diff.lines().take(600) {
                    let col = if line.starts_with('+') && !line.starts_with("+++") {
                        GREEN
                    } else if line.starts_with('-') && !line.starts_with("---") {
                        RED
                    } else if line.starts_with("@@") {
                        ACCENT
                    } else {
                        TEXT_2
                    };
                    ui.label(
                        RichText::new(line)
                            .font(FontId::new(12.5, FontFamily::Monospace))
                            .color(col),
                    );
                }
            });
    }

    fn render_markdown_block(ui: &mut egui::Ui, text: &str) {
        let mut in_code_block = false;
        let mut code_accum = String::new();

        for line in text.lines() {
            if line.trim_start().starts_with("```") {
                if in_code_block {
                    let code_str = code_accum.trim_end().to_string();
                    Frame::none()
                        .fill(CODE_BG)
                        .stroke(Stroke::new(1.0_f32, LINE))
                        .rounding(Rounding::same(6.0))
                        .inner_margin(Margin::symmetric(12.0, 9.0))
                        .show(ui, |ui| {
                            ui.set_min_width(ui.available_width());
                            ui.label(
                                RichText::new(code_str)
                                    .font(FontId::new(13.0, FontFamily::Monospace))
                                    .color(Color32::from_rgb(0xd8, 0xd8, 0xde)),
                            );
                        });
                    ui.add_space(6.0);
                    code_accum.clear();
                    in_code_block = false;
                } else {
                    in_code_block = true;
                }
                continue;
            }

            if in_code_block {
                code_accum.push_str(line);
                code_accum.push('\n');
                continue;
            }

            if let Some(h1) = line.strip_prefix("# ") {
                ui.add_space(8.0);
                ui.label(RichText::new(h1).size(20.0).strong().color(TEXT));
                ui.add_space(4.0);
            } else if let Some(h2) = line.strip_prefix("## ") {
                ui.add_space(10.0);
                ui.label(RichText::new(h2).size(17.0).strong().color(TEXT));
                ui.add_space(4.0);
            } else if let Some(h3) = line.strip_prefix("### ") {
                ui.add_space(6.0);
                ui.label(RichText::new(h3).size(15.5).strong().color(TEXT));
            } else if let Some(bullet) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* "))
            {
                ui.horizontal_wrapped(|ui| {
                    ui.label(RichText::new("•").size(15.0).color(TEXT_2));
                    ui.label(
                        RichText::new(bullet)
                            .size(15.0)
                            .color(Color32::from_rgb(0xdc, 0xdc, 0xdc)),
                    );
                });
            } else if line.trim().is_empty() {
                ui.add_space(6.0);
            } else {
                ui.label(
                    RichText::new(line)
                        .size(15.0)
                        .color(Color32::from_rgb(0xdc, 0xdc, 0xdc)),
                );
            }
        }
    }

    fn extract_message_text(msg: &MessageRow) -> String {
        for part in &msg.parts {
            if part.part_type == "text" {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&part.data) {
                    if let Some(t) = v.get("text").and_then(|s| s.as_str()) {
                        return t.to_string();
                    }
                }
            }
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg.data) {
            if let Some(t) = v.get("text").and_then(|s| s.as_str()) {
                return t.to_string();
            }
        }
        String::new()
    }

    fn icon_btn(ui: &mut egui::Ui, glyph: &str, tooltip: &str, enabled: bool) -> egui::Response {
        let btn = egui::Button::new(RichText::new(glyph).size(15.0).color(if enabled {
            TEXT_2
        } else {
            TEXT_3.linear_multiply(0.4)
        }))
        .fill(Color32::TRANSPARENT)
        .rounding(Rounding::same(6.0))
        .min_size(Vec2::new(30.0, 30.0));
        ui.add_enabled(enabled, btn).on_hover_text(tooltip)
    }
}

impl eframe::App for EntryDesktopApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain_events();

        // Poll active device login every 2 seconds while waiting for user approval
        if !self.auth.authenticated && !self.device_expired {
            if let Some(flow) = &self.device_flow {
                if self.last_device_poll.elapsed() > Duration::from_secs(2) {
                    self.last_device_poll = Instant::now();
                    let code = flow.device_code.clone();
                    self.poll_device_login(&code);
                }
                ctx.request_repaint_after(Duration::from_millis(500));
            }
        }

        // Poll active session while streaming or waiting for permission
        if self.auth.authenticated {
            let poll_interval = if self.is_streaming {
                Duration::from_millis(350)
            } else {
                Duration::from_secs(4)
            };
            if self.last_poll.elapsed() > poll_interval {
                self.last_poll = Instant::now();
                if let Some(sid) = self.active_session_id.clone() {
                    self.load_session(&sid);
                }
            }
            if self.is_streaming {
                ctx.request_repaint_after(Duration::from_millis(200));
            }
        }

        // Gate workspace behind Native Desktop Login Screen when unauthenticated
        if !self.auth.authenticated {
            self.render_login_screen(ctx);
            return;
        }

        // Full-width Right Panel mode (`body.full-right`)
        if self.full_right && self.show_right {
            egui::CentralPanel::default()
                .frame(Frame::none().fill(BG_PANEL))
                .show(ctx, |ui| {
                    self.render_right_column(ui);
                });
            return;
        }

        // Column 1: Left Navigation Sidebar (`--lw: 335px`)
        if self.show_left {
            egui::SidePanel::left("entry_left_column")
                .exact_width(335.0)
                .resizable(false)
                .frame(
                    Frame::none()
                        .fill(BG_SIDE)
                        .stroke(Stroke::new(1.0_f32, LINE)),
                )
                .show(ctx, |ui| {
                    self.render_left_column(ui);
                });
        }

        // Column 3: Right Artifact Panel (`--rw: 560px`)
        if self.show_right {
            egui::SidePanel::right("entry_right_column")
                .exact_width(560.0)
                .resizable(true)
                .frame(
                    Frame::none()
                        .fill(BG_PANEL)
                        .stroke(Stroke::new(1.0_f32, LINE)),
                )
                .show(ctx, |ui| {
                    self.render_right_column(ui);
                });
        }

        // Column 2: Center Chat Column (`minmax(0, 1fr)`)
        egui::CentralPanel::default()
            .frame(Frame::none().fill(BG))
            .show(ctx, |ui| {
                self.render_center_column(ui);
            });
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        if let Some(mut child) = self.sidecar_child.take() {
            let _ = child.kill();
        }
    }
}

fn main() -> eframe::Result<()> {
    let native_options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Entry Desktop")
            .with_inner_size([1440.0, 900.0])
            .with_min_inner_size([960.0, 620.0]),
        ..Default::default()
    };

    eframe::run_native(
        "Entry Desktop",
        native_options,
        Box::new(|cc| Ok(Box::new(EntryDesktopApp::new(cc)))),
    )
}
