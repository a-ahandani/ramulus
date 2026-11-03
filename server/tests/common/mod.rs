#![allow(dead_code)]
use ramulus::server::{App, Config};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

pub const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

pub fn tmp(prefix: &str) -> PathBuf {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).unwrap();
    let name: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let p = std::env::temp_dir().join(format!("{prefix}{name}"));
    std::fs::create_dir_all(&p).unwrap();
    // the real path, since macOS puts temp folders behind a symlink; without Windows' verbatim prefix, which git rejects
    let real = std::fs::canonicalize(p).unwrap().to_string_lossy().into_owned();
    PathBuf::from(real.strip_prefix(r"\\?\").unwrap_or(&real))
}

/// The repository path as git itself reports it, which is what the helper stores and compares.
pub fn toplevel(dir: &Path) -> PathBuf {
    PathBuf::from(git(dir, &["rev-parse", "--show-toplevel"]).trim())
}

pub fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00")
        .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

pub fn write(dir: &Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
}

pub fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}

pub fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

/// A stub `claude` on its own PATH entry: echoes stdin, or fails, prints its folder or stalls when asked by an env var.
pub fn stub_agent(bin: &Path) {
    std::fs::create_dir_all(bin).unwrap();
    #[cfg(windows)]
    std::fs::write(bin.join("claude.cmd"), "@echo off\r\nif defined FAIL goto fail\r\nif defined SHOWDIR (cd & exit /b 0)\r\nif defined SLOW ping -n 30 127.0.0.1 >nul\r\nmore\r\nexit /b 0\r\n:fail\r\necho {\"error\":{\"message\":\"not signed in\"}} 1>&2\r\nexit /b 1\r\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let f = bin.join("claude");
        std::fs::write(&f, "#!/bin/sh\nif [ -n \"$FAIL\" ]; then echo '{\"error\":{\"message\":\"not signed in\"}}' >&2; exit 1; fi\nif [ -n \"$SHOWDIR\" ]; then pwd; exit 0; fi\nif [ -n \"$SLOW\" ]; then sleep 30; fi\ncat\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

pub fn env_with_path(bin: &Path) -> ramulus::Env {
    let mut env = ramulus::env();
    let sep = if cfg!(windows) { ";" } else { ":" };
    let path = ramulus::var(&env, "PATH").unwrap_or("").to_string();
    env.retain(|k, _| !k.eq_ignore_ascii_case("PATH"));
    env.insert("PATH".into(), format!("{}{sep}{path}", bin.display()));
    env
}

pub struct Server {
    pub base: String,
    pub app: Arc<App>,
    agent: ureq::Agent,
}

pub fn config(dir: Option<&Path>, root: &Path, state_dir: &Path) -> Config {
    Config {
        dir: dir.map(|d| s(d).to_string()),
        root: s(root).to_string(),
        ui_dir: root.to_path_buf(),
        token: TOKEN.into(),
        state_file: state_dir.join("recent.json"),
        env: ramulus::env(),
    }
}

impl Server {
    pub fn start(cfg: Config) -> Server {
        let app = App::new(cfg);
        let (tx, rx) = std::sync::mpsc::channel();
        let served = app.clone();
        std::thread::spawn(move || {
            tokio::runtime::Runtime::new().unwrap().block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(listener.local_addr().unwrap().port()).unwrap();
                ramulus::server::serve(served, listener).await.unwrap();
            });
        });
        let port = rx.recv().unwrap();
        let agent = ureq::Agent::new_with_config(
            ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(30)))
                .build(),
        );
        Server {
            base: format!("http://127.0.0.1:{port}"),
            app,
            agent,
        }
    }

    pub fn call_as(&self, op: &str, body: Value, token: &str) -> Value {
        let mut res = self
            .agent
            .post(&format!("{}/api/{op}", self.base))
            .header("x-ramulus-token", token)
            .send_json(&body)
            .unwrap();
        res.body_mut().read_json().unwrap()
    }

    pub fn call(&self, op: &str, body: Value) -> Value {
        self.call_as(op, body, TOKEN)
    }

    pub fn result(&self, op: &str, body: Value) -> Value {
        let v = self.call(op, body);
        assert!(v["error"].is_null(), "{op} failed: {}", v["error"]);
        v["result"].clone()
    }

    pub fn error(&self, op: &str, body: Value) -> String {
        self.call(op, body)["error"].as_str().unwrap_or_default().to_string()
    }

    pub fn get(&self, path: &str) -> ureq::http::Response<ureq::Body> {
        self.agent.get(&format!("{}{path}", self.base)).call().unwrap()
    }

    pub fn stream(&self, path: &str) -> Stream {
        let res = self.get(path);
        assert_eq!(res.status().as_u16(), 200);
        Stream { res, seen: String::new() }
    }
}

pub struct Stream {
    res: ureq::http::Response<ureq::Body>,
    pub seen: String,
}

impl Stream {
    /// Reads until the text has been seen, failing after the agent's global timeout.
    pub fn until(&mut self, text: &str) {
        let mut buf = [0u8; 4096];
        while !self.seen.contains(text) {
            let n = self.res.body_mut().as_reader().read(&mut buf).unwrap();
            if n == 0 {
                panic!("stream ended before {text:?}; saw {:?}", self.seen);
            }
            self.seen.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
    }
}
