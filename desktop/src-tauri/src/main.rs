#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use ramulus::server::{App, Config};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

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

/// Installs a newer release when there is one; true when the app on disk is now the new version.
async fn update_once(handle: &tauri::AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
    let Some(update) = handle.updater()?.check().await? else { return Ok(false) };
    let bytes = update.download(|_, _| {}, || {}).await?;
    let ask = |text: String| {
        handle
            .dialog()
            .message(text)
            .title("Ramulus update")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Restart".into(), "Later".into()))
            .blocking_show()
    };
    if cfg!(windows) {
        // the Windows installer closes the app, so it runs only once the user is ready
        if !ask(format!("Ramulus {} is ready. Restart to update?", update.version)) {
            return Ok(false);
        }
        update.install(bytes)?;
        handle.restart();
    }
    update.install(bytes)?;
    if ask(format!("Ramulus {} is installed. Restart now?", update.version)) {
        handle.restart();
    }
    Ok(true)
}

/// Looks for a newer release shortly after launch and every few hours; the download happens in the background.
fn watch_updates(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            match update_once(&handle).await {
                // the new version is on disk and runs at the next launch, so there is nothing more to check
                Ok(true) => return,
                Ok(false) => {}
                Err(e) => eprintln!("update check: {e}"),
            }
            tokio::time::sleep(Duration::from_secs(4 * 3600)).await;
        }
    });
}

fn main() {
    if let Some(path) = login_path() {
        std::env::set_var("PATH", path);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
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
            watch_updates(tauri_app.handle().clone());
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
