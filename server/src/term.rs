use crate::ai::{agent, find_bin};
use crate::{err, var, Env, Error, Result};
use axum::response::sse::Event;
use futures_core::Stream;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::convert::Infallible;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

pub const KEEP: usize = 200_000;
const MAX_PER_REPO: usize = 8;

/// Keeps the newest `keep` bytes, starting at a line so the replay never opens mid-line.
pub fn trim_tail(buf: &str, keep: usize) -> &str {
    if buf.len() <= keep {
        return buf;
    }
    let from = buf.len() - keep;
    match buf.as_bytes()[from..].iter().position(|&b| b == b'\n') {
        Some(p) => &buf[from + p + 1..],
        None => {
            let mut s = from;
            while !buf.is_char_boundary(s) {
                s += 1;
            }
            &buf[s..]
        }
    }
}

fn size(n: Option<i64>, min: u16, max: u16, fallback: u16) -> u16 {
    n.map(|n| n.clamp(min as i64, max as i64) as u16).unwrap_or(fallback)
}

fn pty(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[derive(Clone, Debug)]
enum Msg {
    Data(String),
    Exit(Option<u32>),
}

struct State {
    buf: String,
    exit: Option<Option<u32>>,
}

struct Session {
    seq: u64,
    kind: &'static str,
    agent: Option<String>,
    state: Mutex<State>,
    tx: broadcast::Sender<Msg>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

type Sessions = Arc<Mutex<HashMap<String, Arc<Session>>>>;

#[derive(Default)]
pub struct Terminals {
    sessions: Sessions,
    seq: AtomicU64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Started {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub fresh: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Tab {
    pub id: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

fn key(repo: &str, id: &str) -> String {
    format!("{repo}\n{id}")
}

fn command(kind: &str, agent_id: &str, env: &Env) -> Result<(String, Vec<String>)> {
    if kind == "shell" {
        return Ok(if cfg!(windows) {
            (var(env, "ComSpec").unwrap_or("cmd.exe").into(), vec![])
        } else {
            (var(env, "SHELL").unwrap_or("/bin/sh").into(), vec![])
        });
    }
    let Some(bin) = agent(agent_id).and_then(|a| find_bin(a.bin, env)) else {
        return err("That AI agent is not installed");
    };
    let bin = bin.to_string_lossy().into_owned();
    Ok(if cfg!(windows) {
        (var(env, "ComSpec").unwrap_or("cmd.exe").into(), vec!["/d".into(), "/c".into(), bin])
    } else {
        (bin, vec![])
    })
}

/// Decodes the complete UTF-8 prefix of `pending`, leaving an unfinished trailing sequence for the next read.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            out
        }
    }
}

/// Forwards the terminal's output until the pty closes.
fn pump(mut reader: Box<dyn Read + Send>, s: &Session) {
    let mut pending = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&chunk[..n]);
        let text = take_utf8(&mut pending);
        if text.is_empty() {
            continue;
        }
        // appending and sending under one lock keeps a replay and the live stream from overlapping
        let mut st = s.state.lock().unwrap();
        st.buf.push_str(&text);
        let drop_to = st.buf.len() - trim_tail(&st.buf, KEEP).len();
        if drop_to > 0 {
            st.buf.drain(..drop_to);
        }
        let _ = s.tx.send(Msg::Data(text));
    }
}

/// Waits for the child, closes the pty so the reader ends (Windows' console pipe stays open until then), and reports the exit.
fn wait_exit(mut child: Box<dyn Child + Send + Sync>, reader: std::thread::JoinHandle<()>, s: Arc<Session>, k: String, sessions: Sessions) {
    let code = child.wait().ok().map(|st| st.exit_code());
    drop(s.master.lock().unwrap().take());
    let _ = reader.join();
    let mut st = s.state.lock().unwrap();
    st.exit = Some(code);
    let mut map = sessions.lock().unwrap();
    if map.get(&k).map(|x| Arc::ptr_eq(x, &s)).unwrap_or(false) {
        map.remove(&k);
    }
    drop(map);
    let _ = s.tx.send(Msg::Exit(code));
}

impl Terminals {
    fn get(&self, repo: &str, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(&key(repo, id)).cloned()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start(&self, repo: &str, id: &str, kind: &str, agent_id: &str, cols: Option<i64>, rows: Option<i64>, env: &Env) -> Result<Started> {
        let (c, r) = (size(cols, 20, 500, 80), size(rows, 5, 200, 24));
        let k = key(repo, id);
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(old) = sessions.get(&k) {
            // a size nudge makes a full-screen program repaint for the tab that came back
            if let Some(m) = old.master.lock().unwrap().as_ref() {
                let _ = m.resize(pty(c, r.saturating_sub(1).max(5)));
                let _ = m.resize(pty(c, r));
            }
            return Ok(Started {
                agent: old.agent.clone(),
                fresh: false,
            });
        }
        let prefix = key(repo, "");
        if sessions.keys().filter(|x| x.starts_with(&prefix)).count() >= MAX_PER_REPO {
            return err("Close a terminal tab before opening another");
        }
        let (file, args) = command(kind, agent_id, env)?;
        let pair = native_pty_system()
            .openpty(pty(c, r))
            .map_err(|e| Error(format!("The terminal is not available on this system: {e}")))?;
        let mut cmd = CommandBuilder::new(&file);
        cmd.args(&args);
        cmd.cwd(repo);
        cmd.env_clear();
        for (name, value) in env {
            cmd.env(name, value);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let child = pair.slave.spawn_command(cmd).map_err(|e| Error(e.to_string()))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| Error(e.to_string()))?;
        let writer = pair.master.take_writer().map_err(|e| Error(e.to_string()))?;
        let killer = child.clone_killer();
        let (tx, _) = broadcast::channel(1024);
        let agent = (kind != "shell").then(|| agent_id.to_string());
        let s = Arc::new(Session {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            kind: if kind == "shell" { "shell" } else { "agent" },
            agent: agent.clone(),
            state: Mutex::new(State { buf: String::new(), exit: None }),
            tx,
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
        });
        sessions.insert(k.clone(), s.clone());
        drop(sessions);
        let all = self.sessions.clone();
        let for_reader = s.clone();
        let reading = std::thread::spawn(move || pump(reader, &for_reader));
        std::thread::spawn(move || wait_exit(child, reading, s, k, all));
        Ok(Started { agent, fresh: true })
    }

    pub fn list(&self, repo: &str) -> Vec<Tab> {
        let prefix = key(repo, "");
        let mut tabs: Vec<(u64, Tab)> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(k, s)| {
                (
                    s.seq,
                    Tab {
                        id: k[prefix.len()..].to_string(),
                        kind: s.kind,
                        agent: s.agent.clone(),
                    },
                )
            })
            .collect();
        tabs.sort_by_key(|(seq, _)| *seq);
        tabs.into_iter().map(|(_, t)| t).collect()
    }

    /// The terminal's output as server-sent events: a replay of what it printed, then live data, then `exit`.
    pub fn attach(&self, repo: &str, id: &str) -> impl Stream<Item = std::result::Result<Event, Infallible>> {
        let session = self.get(repo, id);
        let data = |d: &str| Event::default().data(serde_json::to_string(d).unwrap_or_default());
        let exit = |code: Option<u32>| Event::default().event("exit").data(code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()));
        async_stream::stream! {
            yield Ok(Event::default().comment("connected"));
            if let Some(s) = session {
                let (mut rx, buf, exited) = {
                    let st = s.state.lock().unwrap();
                    (s.tx.subscribe(), st.buf.clone(), st.exit)
                };
                if !buf.is_empty() {
                    yield Ok(data(&buf));
                }
                match exited {
                    Some(code) => yield Ok(exit(code)),
                    None => loop {
                        match rx.recv().await {
                            Ok(Msg::Data(d)) => yield Ok(data(&d)),
                            Ok(Msg::Exit(code)) => {
                                yield Ok(exit(code));
                                break;
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => {
                                yield Ok(exit(None));
                                break;
                            }
                        }
                    },
                }
            } else {
                yield Ok(exit(None));
            }
            // like the browser, the client closes on exit; until then the connection stays open
            std::future::pending::<()>().await;
        }
    }

    pub async fn write(&self, repo: &str, id: &str, data: String) {
        let Some(s) = self.get(repo, id) else { return };
        let _ = tokio::task::spawn_blocking(move || {
            let mut w = s.writer.lock().unwrap();
            let _ = w.write_all(data.as_bytes());
            let _ = w.flush();
        })
        .await;
    }

    pub fn resize(&self, repo: &str, id: &str, cols: Option<i64>, rows: Option<i64>) {
        if let Some(s) = self.get(repo, id) {
            if let Some(m) = s.master.lock().unwrap().as_ref() {
                let _ = m.resize(pty(size(cols, 20, 500, 80), size(rows, 5, 200, 24)));
            }
        }
    }

    fn stop_key(&self, k: &str) {
        let s = self.sessions.lock().unwrap().remove(k);
        if let Some(s) = s {
            let _ = s.killer.lock().unwrap().kill();
        }
    }

    pub fn stop(&self, repo: &str, id: Option<&str>) {
        match id {
            Some(id) => self.stop_key(&key(repo, id)),
            None => {
                let prefix = key(repo, "");
                let keys: Vec<String> = self.sessions.lock().unwrap().keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
                for k in keys {
                    self.stop_key(&k);
                }
            }
        }
    }

    pub fn stop_all(&self) {
        let keys: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for k in keys {
            self.stop_key(&k);
        }
    }
}
