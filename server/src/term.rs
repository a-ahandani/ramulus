use crate::ai::{agent, find_bin};
use crate::wake::Wake;
use crate::{err, home, var, Env, Error, Result};
use axum::response::sse::Event;
use futures_core::Stream;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

pub const KEEP: usize = 200_000;
const MAX_PER_REPO: usize = 8;
const TITLE_MAX: usize = 120;
const SAVE_EVERY: Duration = Duration::from_secs(2);
/// A helper saving more recently than this still runs, and keeps the saved tabs to itself.
const OWNER_FRESH: Duration = Duration::from_secs(6);
/// How often the helper looks for a working agent, and how long after its last output another agent still counts as working.
const WAKE_EVERY: Duration = Duration::from_secs(10);
pub const QUIET: Duration = Duration::from_secs(60);
/// Printed between a restored tab's old output and the program started again below it; it leaves a full-screen program's screen without moving the cursor.
const RESTORED: &str = "\x1b[?47l\x1b[!p\r\n\x1b[2m─── new session ───\x1b[0m\r\n";

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

/// The last complete window title (OSC 0 or 2) in `s`, the way Claude Code names its conversation.
pub fn last_title(s: &str) -> Option<&str> {
    let mut last = None;
    let mut from = 0;
    while let Some(i) = s[from..].find("\x1b]") {
        from += i + 2;
        let body = &s[from..];
        let Some(text) = body.strip_prefix("0;").or_else(|| body.strip_prefix("2;")) else {
            continue;
        };
        let Some(end) = text.find(['\x07', '\x1b']) else { break };
        if text[end..].starts_with('\x07') || text[end..].starts_with("\x1b\\") {
            last = Some(&text[..end]);
        }
    }
    last
}

pub fn clean_title(t: &str) -> Option<String> {
    let t: String = t.chars().filter(|c| !c.is_control()).collect();
    let t: String = t.trim().chars().take(TITLE_MAX).collect();
    (!t.is_empty()).then_some(t)
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
    title: Option<String>,
    /// the output changed since it was last saved
    unsaved: bool,
    last_output: Option<Instant>,
}

/// A terminal tab. It outlives its program: an ended or restored tab starts again as itself.
struct Session {
    seq: u64,
    kind: &'static str,
    agent: Option<String>,
    /// names the saved output, and is Claude Code's session id so the tab resumes its conversation
    uuid: String,
    /// the conversation another agent goes back to whenever this tab starts
    resume: Option<String>,
    /// when its program started, in ms
    started: i64,
    state: Mutex<State>,
    tx: broadcast::Sender<Msg>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
}

impl Session {
    fn new(seq: u64, kind: &'static str, agent: Option<String>, uuid: String, buf: String, title: Option<String>, exit: Option<Option<u32>>) -> Session {
        Session {
            seq,
            kind,
            agent,
            uuid,
            resume: None,
            started: now_ms(),
            state: Mutex::new(State {
                buf,
                exit,
                title,
                unsaved: true,
                last_output: None,
            }),
            tx: broadcast::channel(1024).0,
            master: Mutex::new(None),
            writer: Mutex::new(None),
            killer: Mutex::new(None),
        }
    }

    /// The agent keeps the conversation itself and prints it again on resume.
    fn resumes(&self) -> bool {
        self.agent.as_deref() == Some("claude") || self.resume.is_some()
    }
}

type Sessions = Arc<Mutex<HashMap<String, Arc<Session>>>>;

/// The tabs as saved in index.json, each one's output in <uuid>.log beside it.
#[derive(Serialize, Deserialize)]
struct Saved {
    repo: String,
    id: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    uuid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resume: Option<String>,
}

struct Store {
    dir: PathBuf,
    /// the index as last written, which also keeps two saves from interleaving
    index: Mutex<String>,
    closed: std::sync::atomic::AtomicBool,
}

fn write_atomic(file: &Path, text: &str) -> std::io::Result<()> {
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(tmp, file)
}

impl Store {
    fn save(&self, sessions: &Sessions, output: bool) {
        let mut last = self.index.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let mut list: Vec<(String, Arc<Session>)> = sessions.lock().unwrap().iter().map(|(k, s)| (k.clone(), s.clone())).collect();
        list.sort_by_key(|(_, s)| s.seq);
        let saved: Vec<Saved> = list
            .iter()
            .filter_map(|(k, s)| {
                let (repo, id) = k.rsplit_once('\n')?;
                Some(Saved {
                    repo: repo.into(),
                    id: id.into(),
                    kind: s.kind.into(),
                    agent: s.agent.clone(),
                    title: s.state.lock().unwrap().title.clone(),
                    uuid: s.uuid.clone(),
                    resume: s.resume.clone(),
                })
            })
            .collect();
        let text = serde_json::to_string(&saved).unwrap_or_default();
        let _ = std::fs::create_dir_all(&self.dir);
        let _ = std::fs::write(self.dir.join("owner"), std::process::id().to_string());
        if text != *last && write_atomic(&self.dir.join("index.json"), &text).is_ok() {
            *last = text;
        }
        if !output {
            return;
        }
        for (_, s) in list.iter().filter(|(_, s)| !s.resumes()) {
            let buf = {
                let mut st = s.state.lock().unwrap();
                if !st.unsaved {
                    continue;
                }
                st.unsaved = false;
                st.buf.clone()
            };
            let _ = write_atomic(&self.dir.join(format!("{}.log", s.uuid)), &buf);
        }
    }

    /// The last save of this run; the next helper takes the tabs over at once.
    fn close(&self, sessions: &Sessions) {
        self.save(sessions, true);
        let _last = self.index.lock().unwrap();
        self.closed.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_file(self.dir.join("owner"));
    }

    fn forget(&self, uuid: &str) {
        let _ = std::fs::remove_file(self.dir.join(format!("{uuid}.log")));
    }
}

pub struct Terminals {
    sessions: Sessions,
    seq: AtomicU64,
    store: Option<Arc<Store>>,
    wake: Arc<Wake>,
}

/// An agent at work keeps the computer awake: Claude Code by its title, the others while they printed within `quiet`.
fn working(sessions: &Sessions, quiet: Duration) -> bool {
    sessions.lock().unwrap().values().any(|s| {
        let st = s.state.lock().unwrap();
        s.kind == "agent"
            && st.exit.is_none()
            && match s.agent.as_deref() {
                Some("claude") => claude_busy(st.title.as_deref()),
                _ => st.last_output.is_some_and(|t| t.elapsed() < quiet),
            }
    })
}

fn keep_awake(sessions: Weak<Mutex<HashMap<String, Arc<Session>>>>, wake: Arc<Wake>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(WAKE_EVERY);
        let Some(sessions) = sessions.upgrade() else {
            wake.set(false);
            return;
        };
        wake.set(working(&sessions, QUIET));
    });
}

fn valid_uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// A session id goes to the agent as an argument, through cmd.exe on Windows.
pub fn valid_session_id(s: &str) -> bool {
    (1..=100).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// How the other agents go back to a conversation; Claude Code tabs carry theirs as the tab's uuid.
fn resume_args(agent: &str, id: &str) -> Option<Vec<String>> {
    match agent {
        "codex" => Some(vec!["resume".into(), id.into()]),
        "opencode" => Some(vec!["--session".into(), id.into()]),
        _ => None,
    }
}

/// The agent sessions a folder's tabs hold, by id, and for each other agent with a running new tab, when the first such
/// tab started: what that agent changed since then is the tab's own, since its id is not known.
#[derive(Default, Debug)]
pub struct Held {
    pub ids: HashSet<String>,
    pub since: HashMap<String, i64>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_uuid() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| Error(e.to_string()))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]))
}

/// Claude Code's title starts with ✳ when it waits for you and with a spinner while it works, as the app reads it too.
pub fn claude_busy(title: Option<&str>) -> bool {
    let Some(t) = title else { return false };
    let mut chars = t.chars();
    let Some(first) = chars.next().filter(|c| !c.is_whitespace()) else { return false };
    let rest = chars.as_str();
    rest.starts_with(char::is_whitespace) && !rest.trim_start().is_empty() && !first.is_alphanumeric() && first != '\u{2733}'
}

/// Whether Claude Code saved a conversation under this id, which it does once the first message is sent.
fn claude_has(env: &Env, uuid: &str) -> bool {
    let base = var(env, "CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".claude"));
    let file = format!("{uuid}.jsonl");
    std::fs::read_dir(base.join("projects"))
        .map(|dirs| dirs.flatten().any(|d| d.path().join(&file).is_file()))
        .unwrap_or(false)
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

fn key(repo: &str, id: &str) -> String {
    format!("{repo}\n{id}")
}

fn command(kind: &str, agent_id: &str, extra: Vec<String>, env: &Env) -> Result<(String, Vec<String>)> {
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
        (var(env, "ComSpec").unwrap_or("cmd.exe").into(), [vec!["/d".into(), "/c".into(), bin], extra].concat())
    } else {
        (bin, extra)
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
        st.unsaved = true;
        st.last_output = Some(Instant::now());
        // a title can arrive split across reads, so look a little before this one too
        let mut from = st.buf.len().saturating_sub(text.len() + 256);
        while !st.buf.is_char_boundary(from) {
            from += 1;
        }
        if let Some(t) = last_title(&st.buf[from..]) {
            st.title = clean_title(t);
        }
        let drop_to = st.buf.len() - trim_tail(&st.buf, KEEP).len();
        if drop_to > 0 {
            st.buf.drain(..drop_to);
        }
        let _ = s.tx.send(Msg::Data(text));
    }
}

/// Waits for the child, closes the pty so the reader ends (Windows' console pipe stays open until then), and reports the exit.
fn wait_exit(mut child: Box<dyn Child + Send + Sync>, reader: std::thread::JoinHandle<()>, s: Arc<Session>) {
    let code = child.wait().ok().map(|st| st.exit_code());
    drop(s.master.lock().unwrap().take());
    let _ = reader.join();
    let mut st = s.state.lock().unwrap();
    st.exit = Some(code);
    let _ = s.tx.send(Msg::Exit(code));
}

/// Saves the tabs every few seconds while the terminals exist, so a crash loses little.
fn keep_saving(sessions: Weak<Mutex<HashMap<String, Arc<Session>>>>, store: Arc<Store>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(SAVE_EVERY);
        let Some(sessions) = sessions.upgrade().filter(|_| !store.closed.load(Ordering::SeqCst)) else {
            return;
        };
        store.save(&sessions, true);
    });
}

impl Terminals {
    /// Terminals that save their tabs in `dir`, starting with the ones saved by the last run.
    /// While another helper is saving there, this one keeps its tabs for this run only.
    pub fn new(dir: Option<PathBuf>) -> Terminals {
        let in_use = |dir: &Path| {
            let age = std::fs::metadata(dir.join("owner")).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
            age.is_some_and(|a| a < OWNER_FRESH)
        };
        let t = Terminals {
            sessions: Default::default(),
            seq: AtomicU64::new(0),
            store: dir.filter(|d| !in_use(d)).map(|dir| {
                Arc::new(Store {
                    dir,
                    index: Mutex::new(String::new()),
                    closed: Default::default(),
                })
            }),
            wake: Default::default(),
        };
        keep_awake(Arc::downgrade(&t.sessions), t.wake.clone());
        if let Some(store) = &t.store {
            let text = std::fs::read_to_string(store.dir.join("index.json")).unwrap_or_default();
            let saved: Vec<Saved> = serde_json::from_str(&text).unwrap_or_default();
            let mut map = t.sessions.lock().unwrap();
            for e in saved {
                let kind = if e.kind == "shell" { "shell" } else { "agent" };
                if !valid_uuid(&e.uuid) || !Path::new(&e.repo).is_dir() || map.contains_key(&key(&e.repo, &e.id)) {
                    continue;
                }
                let buf = std::fs::read_to_string(store.dir.join(format!("{}.log", e.uuid))).unwrap_or_default();
                let agent = e.agent.filter(|a| agent(a).is_some());
                let resume = e.resume.filter(|r| agent.as_deref().is_some_and(|a| resume_args(a, r).is_some()) && valid_session_id(r));
                let mut s = Session::new(
                    t.seq.fetch_add(1, Ordering::Relaxed),
                    kind,
                    agent,
                    e.uuid,
                    trim_tail(&buf, KEEP).to_string(),
                    e.title.as_deref().and_then(clean_title),
                    Some(None),
                );
                s.resume = resume;
                s.state.lock().unwrap().unsaved = false;
                map.insert(key(&e.repo, &e.id), Arc::new(s));
            }
            let kept: HashSet<String> = map.values().map(|s| format!("{}.log", s.uuid)).collect();
            drop(map);
            for f in std::fs::read_dir(&store.dir).into_iter().flatten().flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                if name.ends_with(".log") && !kept.contains(&name) {
                    let _ = std::fs::remove_file(f.path());
                }
            }
            *store.index.lock().unwrap() = text;
            store.save(&t.sessions, false);
            keep_saving(Arc::downgrade(&t.sessions), store.clone());
        }
        t
    }

    fn save_index(&self) {
        if let Some(store) = &self.store {
            store.save(&self.sessions, false);
        }
    }

    fn get(&self, repo: &str, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(&key(repo, id)).cloned()
    }

    /// `resume` names an agent conversation for a new tab to go back to instead of starting one.
    #[allow(clippy::too_many_arguments)]
    pub fn start(&self, repo: &str, id: &str, kind: &str, agent_id: &str, cols: Option<i64>, rows: Option<i64>, resume: Option<&str>, env: &Env) -> Result<Started> {
        let (c, r) = (size(cols, 20, 500, 80), size(rows, 5, 200, 24));
        let k = key(repo, id);
        let mut sessions = self.sessions.lock().unwrap();
        let old = sessions.get(&k).cloned();
        if let Some(old) = old.as_ref().filter(|o| o.state.lock().unwrap().exit.is_none()) {
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
        if old.is_none() && sessions.keys().filter(|x| x.starts_with(&prefix)).count() >= MAX_PER_REPO {
            return err("Close a terminal tab before opening another");
        }
        let claude = kind != "shell" && agent_id == "claude";
        if let Some(r) = resume.filter(|_| old.is_none()) {
            if !(if claude {
                valid_uuid(r)
            } else {
                kind != "shell" && resume_args(agent_id, r).is_some() && valid_session_id(r)
            }) {
                return err("That conversation cannot be resumed");
            }
        }
        // an ended or restored tab starts again as itself, below what it printed before
        let mut s = match &old {
            Some(o) => {
                let st = o.state.lock().unwrap();
                let buf = if o.resumes() || st.buf.is_empty() {
                    String::new()
                } else {
                    format!("{}{RESTORED}", st.buf)
                };
                let mut s = Session::new(o.seq, o.kind, o.agent.clone(), o.uuid.clone(), buf, st.title.clone(), None);
                s.resume = o.resume.clone();
                s
            }
            None => {
                let kind = if kind == "shell" { "shell" } else { "agent" };
                let agent = (kind != "shell").then(|| agent_id.to_string());
                let uuid = match resume.filter(|_| claude) {
                    Some(r) => r.to_string(),
                    None => new_uuid()?,
                };
                Session::new(self.seq.fetch_add(1, Ordering::Relaxed), kind, agent, uuid, String::new(), None, None)
            }
        };
        if old.is_none() && !claude {
            s.resume = resume.map(String::from);
        }
        let extra = match (s.agent.as_deref(), &s.resume) {
            (Some("claude"), _) => vec![if claude_has(env, &s.uuid) { "--resume" } else { "--session-id" }.to_string(), s.uuid.clone()],
            (Some(a), Some(r)) => resume_args(a, r).unwrap_or_default(),
            _ => vec![],
        };
        let (file, args) = command(s.kind, s.agent.as_deref().unwrap_or(""), extra, env)?;
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
        *s.writer.lock().unwrap() = Some(pair.master.take_writer().map_err(|e| Error(e.to_string()))?);
        *s.killer.lock().unwrap() = Some(child.clone_killer());
        *s.master.lock().unwrap() = Some(pair.master);
        let s = Arc::new(s);
        let agent = s.agent.clone();
        sessions.insert(k, s.clone());
        drop(sessions);
        self.save_index();
        let for_reader = s.clone();
        let reading = std::thread::spawn(move || pump(reader, &for_reader));
        std::thread::spawn(move || wait_exit(child, reading, s));
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
                        title: s.state.lock().unwrap().title.clone(),
                    },
                )
            })
            .collect();
        tabs.sort_by_key(|(seq, _)| *seq);
        tabs.into_iter().map(|(_, t)| t).collect()
    }

    /// The terminal's output as server-sent events: a replay of what it printed, then live data, then `exit`.
    /// The agent sessions this folder's tabs hold: Claude Code tabs by id, resumed tabs by what they resumed, and for
    /// the other agents, whatever changed since a running new tab of theirs started, since that tab's id is not known.
    pub fn held(&self, repo: &str) -> Held {
        let prefix = key(repo, "");
        let mut held = Held::default();
        for (k, s) in self.sessions.lock().unwrap().iter() {
            if !k.starts_with(&prefix) {
                continue;
            }
            match (s.agent.as_deref(), &s.resume) {
                (Some("claude"), _) => {
                    held.ids.insert(s.uuid.clone());
                }
                (_, Some(r)) => {
                    held.ids.insert(r.clone());
                }
                (Some(a), None) if s.state.lock().unwrap().exit.is_none() => {
                    let at = held.since.entry(a.to_string()).or_insert(s.started);
                    *at = (*at).min(s.started);
                }
                _ => {}
            }
        }
        held
    }

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
            if let Some(w) = s.writer.lock().unwrap().as_mut() {
                let _ = w.write_all(data.as_bytes());
                let _ = w.flush();
            }
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

    /// Closes a tab for good: its program ends and its saved output goes.
    fn stop_key(&self, k: &str) {
        let s = self.sessions.lock().unwrap().remove(k);
        if let Some(s) = s {
            if let Some(killer) = s.killer.lock().unwrap().as_mut() {
                let _ = killer.kill();
            }
            if let Some(store) = &self.store {
                store.forget(&s.uuid);
            }
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
        self.save_index();
    }

    /// Whether an agent tab is at work, counting the others as working when they printed within `quiet`.
    pub fn working(&self, quiet: Duration) -> bool {
        working(&self.sessions, quiet)
    }

    /// Saves every tab for the next run, then ends their programs; this is the helper shutting down, not tabs closing.
    pub fn stop_all(&self) {
        self.wake.set(false);
        if let Some(store) = &self.store {
            store.close(&self.sessions);
        }
        let all: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();
        for s in all {
            if let Some(killer) = s.killer.lock().unwrap().as_mut() {
                let _ = killer.kill();
            }
        }
    }
}
