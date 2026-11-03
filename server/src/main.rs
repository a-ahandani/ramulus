use ramulus::server::{App, Config};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1)
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("signal handler");
        let mut hup = signal(SignalKind::hangup()).expect("signal handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
            _ = hup.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("Usage: ramulus [path] [--port N] [--no-open] [--ui DIR]\n\nServes the Ramulus UI for the repository at path (default: current directory).");
        return;
    }
    let (mut port, mut no_open, mut ui, mut path) = (0u16, false, None::<PathBuf>, None::<String>);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                port = args.get(i).and_then(|p| p.parse().ok()).unwrap_or_else(|| fail("--port needs a number from 0 to 65535"));
            }
            "--no-open" => no_open = true,
            "--ui" => {
                i += 1;
                ui = args.get(i).map(PathBuf::from);
            }
            a if a.starts_with('-') => {}
            a => {
                if path.is_none() {
                    path = Some(a.to_string());
                }
            }
        }
        i += 1;
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let root = ramulus::resolve(&cwd, Path::new(path.as_deref().unwrap_or(".")));
    if !root.is_dir() {
        fail(&format!("No such folder: {}", root.display()));
    }
    let root = root.to_string_lossy().into_owned();
    let version = ramulus::git::try_run(&root, &["--version"], None).await.map(|o| o.text()).unwrap_or_default();
    if let Some(problem) = ramulus::git::git_problem(&version) {
        fail(&problem);
    }
    let dir = match ramulus::git::toplevel(&root).await {
        Ok(d) => Some(d),
        Err(e) => {
            if !e.0.contains("not a git repository") {
                eprintln!("{}", e.0.trim());
            }
            None
        }
    };
    let exe_dir = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let ui_dir = match ui {
        Some(u) => ramulus::resolve(&cwd, &u),
        None => [exe_dir.join("ui"), exe_dir.join("../ui")]
            .into_iter()
            .map(|p| ramulus::resolve(&cwd, &p))
            .find(|p| p.join("index.html").is_file())
            .unwrap_or_else(|| exe_dir.join("ui")),
    };
    if !ui_dir.join("index.html").is_file() {
        fail("The UI build is missing. Run `npm run build` in the cli folder first.");
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap_or_else(|e| fail(&format!("No randomness for the session token: {e}")));
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let app = App::new(Config {
        dir: dir.clone(),
        root: root.clone(),
        ui_dir,
        token: token.clone(),
        state_file: Config::default_state_file(),
        env: ramulus::env(),
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap_or_else(|e| fail(&format!("Could not listen on 127.0.0.1:{port}: {e}")));
    let url = format!("http://127.0.0.1:{}/#{token}", listener.local_addr().map(|a| a.port()).unwrap_or(port));
    let where_ = match &dir {
        Some(d) => format!("Ramulus is serving {d}"),
        None => format!("{root} is not a git repository. Pick repositories in the browser."),
    };
    println!("{where_}\n{url}\nPress Ctrl+C to stop.");
    if !no_open {
        let _ = ramulus::git::open_external(OsStr::new(&url));
    }
    tokio::select! {
        r = ramulus::server::serve(app.clone(), listener) => if let Err(e) = r { fail(&e.to_string()) },
        _ = shutdown() => {
            app.stop_agents();
            std::process::exit(0);
        }
    }
}
