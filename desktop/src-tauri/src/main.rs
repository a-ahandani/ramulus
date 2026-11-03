#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use ramulus::server::{App, Config};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Apps started from the Dock get a bare PATH; the login shell has the one with git, gh and the agents.
#[cfg(target_os = "macos")]
fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = std::process::Command::new(shell).args(["-lc", "printf %s \"$PATH\""]).output();
        let _ = tx.send(out.ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()));
    });
    // a profile that waits for input must not keep the window from opening
    rx.recv_timeout(std::time::Duration::from_secs(5)).ok().flatten().filter(|p| !p.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn login_path() -> Option<String> {
    None
}

fn ui_dir(app: &tauri::App) -> Option<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|r| r.join("ui"));
    let checkout = cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../cli/ui"));
    [bundled, checkout].into_iter().flatten().find(|p| p.join("index.html").is_file())
}

fn main() {
    if let Some(path) = login_path() {
        std::env::set_var("PATH", path);
    }
    tauri::Builder::default()
        .setup(|tauri_app| {
            let ui_dir = ui_dir(tauri_app).ok_or("The UI build is missing. Run `npm run build` in the cli folder first.")?;
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let home = ramulus::home().to_string_lossy().into_owned();
            let app = App::new(Config {
                dir: None,
                root: home,
                ui_dir,
                token: token.clone(),
                state_file: Config::default_state_file(),
                env: ramulus::env(),
            });
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            listener.set_nonblocking(true)?;
            let port = listener.local_addr()?.port();
            let served = app.clone();
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("listener");
                if let Err(e) = ramulus::server::serve(served, listener).await {
                    eprintln!("{e}");
                }
            });
            tauri_app.manage(app);
            let url = format!("http://127.0.0.1:{port}/#{token}").parse()?;
            WebviewWindowBuilder::new(tauri_app, "main", WebviewUrl::External(url))
                .title("Ramulus")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the app could not start")
        .run(|handle, event| {
            if let RunEvent::Exit = event {
                handle.state::<Arc<App>>().stop_agents();
            }
        });
}
