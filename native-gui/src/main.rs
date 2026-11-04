#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::thread;
use std::time::{Duration, Instant};

use tao::dpi::LogicalSize;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
use tao::window::{Icon, WindowBuilder};
use wry::WebViewBuilder;

const SINGLE_INSTANCE_PORT: u16 = 4097;
const SIDECAR_PORT: u16 = 4096;
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug)]
enum UserEvent {
    ProtocolCallback(String),
}

fn forward_to_primary_instance(arg: &str) -> bool {
    if let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{}", SINGLE_INSTANCE_PORT)) {
        let msg = format!("{}\\n", arg);
        let _ = stream.write_all(msg.as_bytes());
        return true;
    }
    false
}

fn start_single_instance_listener(tx: Sender<String>) {
    thread::spawn(move || {
        if let Ok(listener) = TcpListener::bind(format!("127.0.0.1:{}", SINGLE_INSTANCE_PORT)) {
            for stream in listener.incoming() {
                if let Ok(mut stream) = stream {
                    let mut buf = [0u8; 2048];
                    if let Ok(n) = stream.read(&mut buf) {
                        if n > 0 {
                            let text = String::from_utf8_lossy(&buf[..n]).trim().to_string();
                            let _ = tx.send(text);
                        }
                    }
                }
            }
        }
    });
}

fn is_sidecar_healthy() -> bool {
    let url = format!("http://127.0.0.1:{}/health", SIDECAR_PORT);
    ureq::get(&url)
        .timeout(Duration::from_millis(600))
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}

fn find_sidecar_executable() -> Option<PathBuf> {
    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let candidates = [
                parent.join("entry-agent-sidecar.exe"),
                parent.join("entry-agent-sidecar"),
                parent.join("dist").join("entry-agent-sidecar.exe"),
                parent.join("..").join("dist").join("entry-agent-sidecar.exe"),
            ];
            for c in candidates {
                if c.exists() {
                    return Some(c);
                }
            }
        }
    }
    None
}

fn spawn_sidecar() -> Option<Child> {
    if is_sidecar_healthy() {
        return None;
    }

    if let Some(sidecar_path) = find_sidecar_executable() {
        let mut cmd = Command::new(&sidecar_path);
        cmd.stdin(Stdio::null())
           .stdout(Stdio::null())
           .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        if let Ok(child) = cmd.spawn() {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(4) {
                if is_sidecar_healthy() {
                    break;
                }
                thread::sleep(Duration::from_millis(150));
            }
            return Some(child);
        }
    }
    None
}

fn create_entry_icon() -> Option<Icon> {
    // Generate 32x32 RGBA icon matching Entry logo
    let size = 32u32;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            // Dark rounded background
            let is_corner = (x < 4 || x >= 28) && (y < 4 || y >= 28);
            if is_corner {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                // Three white diagonal stripes
                let is_stripe = (x >= 8 && x <= 12 && y >= 6 && y <= 26)
                    || (x >= 14 && x <= 18 && y >= 6 && y <= 26)
                    || (x >= 20 && x <= 24 && y >= 6 && y <= 26);
                if is_stripe {
                    rgba.extend_from_slice(&[255, 255, 255, 255]);
                } else {
                    rgba.extend_from_slice(&[20, 20, 20, 255]);
                }
            }
        }
    }
    Icon::from_rgba(rgba, size, size).ok()
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let initial_arg = if args.len() > 1 { args[1].clone() } else { String::new() };

    // 1. Single Instance Check: forward to existing window if already running
    if !initial_arg.is_empty() && forward_to_primary_instance(&initial_arg) {
        std::process::exit(0);
    }

    // 2. Spawn sidecar silently if not already running
    let _sidecar_child = spawn_sidecar();

    // 3. Setup event loop and single instance listener
    let event_loop: EventLoop<UserEvent> = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let (tx, rx) = channel::<String>();

    start_single_instance_listener(tx);

    // Thread to forward TCP messages to EventLoop
    thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            let _ = proxy.send_event(UserEvent::ProtocolCallback(msg));
        }
    });

    // 4. Create Native Window
    let window = WindowBuilder::new()
        .with_title("Entry")
        .with_inner_size(LogicalSize::new(1320.0, 840.0))
        .with_min_inner_size(LogicalSize::new(880.0, 560.0))
        .with_window_icon(create_entry_icon())
        .build(&event_loop)
        .expect("Failed to create native Entry window");

    // 5. Create WebView2 instance pointing to local sidecar
    let webview_url = format!("http://127.0.0.1:{}/", SIDECAR_PORT);
    let webview = WebViewBuilder::new()
        .with_url(&webview_url)
        .with_devtools(cfg!(debug_assertions))
        .with_background_color((20, 20, 20, 255))
        .build(&window)
        .expect("Failed to initialize WebView2");

    // 6. Run Event Loop
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::NewEvents(StartCause::Init) => {}
            Event::UserEvent(UserEvent::ProtocolCallback(url_or_arg)) => {
                window.set_focus();
                // Send callback to webview
                let js = format!(
                    "window.dispatchEvent(new CustomEvent('entry:protocol', {{ detail: '{}' }}));",
                    url_or_arg.replace("'", "\\'")
                );
                let _ = webview.evaluate_script(&js);
            }
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::CloseRequested => {
                    *control_flow = ControlFlow::Exit;
                }
                _ => {}
            },
            _ => {}
        }
    });
}
