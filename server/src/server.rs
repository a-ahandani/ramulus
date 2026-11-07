use crate::git::{self, DiffArea, FileChange};
use crate::term::Terminals;
use crate::{ai, err, home, prs, resolve, sessions, Env, Error, Result};
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Query, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use notify::Watcher as _;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

pub struct Config {
    /// The repository the helper started in, if it started in one.
    pub dir: Option<String>,
    pub root: String,
    pub ui_dir: PathBuf,
    pub token: String,
    /// recent.json; pinned.json, prefs.json and ai.json live beside it.
    pub state_file: PathBuf,
    pub env: Env,
}

impl Config {
    pub fn default_state_file() -> PathBuf {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".config"));
        base.join("ramulus").join("recent.json")
    }
}

struct Watch {
    tx: broadcast::Sender<()>,
    clients: AtomicUsize,
    _watcher: Option<notify::RecommendedWatcher>,
}

pub struct App {
    cfg: Config,
    known: Mutex<HashSet<String>>,
    watchers: Mutex<HashMap<String, Arc<Watch>>>,
    terms: Terminals,
}

const SHELL_OPS: [&str; 10] = ["repos", "pins", "setPins", "prefs", "setPrefs", "findRepos", "pickFolder", "ai", "setAi", "openRepo"];
const REPO_OPS: [&str; 50] = [
    "load",
    "init",
    "files",
    "prs",
    "ciRuns",
    "prMerge",
    "prView",
    "prConversation",
    "prChange",
    "status",
    "commitFiles",
    "fileVersions",
    "writeIndex",
    "writeWorkdir",
    "openPath",
    "revealPath",
    "stage",
    "unstage",
    "discard",
    "commit",
    "checkoutBranch",
    "checkoutRemote",
    "checkoutCommit",
    "createBranch",
    "deleteBranch",
    "deleteRemoteBranch",
    "renameBranch",
    "createTag",
    "deleteTag",
    "stashSave",
    "stashApply",
    "stashDrop",
    "merge",
    "rebase",
    "undoRebase",
    "dropAutostash",
    "cherryPick",
    "revert",
    "reset",
    "abort",
    "continue",
    "fetchAll",
    "pull",
    "push",
    "aiContext",
    "termStart",
    "termList",
    "agentSessions",
    "termStop",
    "aiAsk",
];

struct Body<'a>(&'a Value);

impl Body<'_> {
    fn get(&self, k: &str) -> &Value {
        &self.0[k]
    }
    fn str(&self, k: &str) -> Option<&str> {
        self.0[k].as_str()
    }
    fn string(&self, k: &str) -> String {
        self.str(k).unwrap_or("").to_string()
    }
    fn i64(&self, k: &str) -> Option<i64> {
        self.0[k].as_i64()
    }
    fn truthy(&self, k: &str) -> bool {
        match &self.0[k] {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
            Value::String(s) => !s.is_empty(),
            _ => true,
        }
    }
    fn paths(&self, k: &str) -> Result<Vec<String>> {
        let Some(list) = self.0[k].as_array().filter(|a| !a.is_empty()) else {
            return err("No files given");
        };
        list.iter()
            .map(|p| p.as_str().filter(|s| !s.is_empty()).map(String::from).ok_or(Error("Invalid path".into())))
            .collect()
    }
}

fn val<T: Serialize>(x: T) -> Result<Value> {
    Ok(serde_json::to_value(x)?)
}

fn done() -> Result<Value> {
    Ok(Value::Null)
}

fn info(dir: &str) -> Value {
    json!({ "dir": dir, "name": Path::new(dir).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() })
}

fn flat_strings(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => vec![],
    }
}

fn read_list(file: &Path) -> Vec<String> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| flat_strings(&v))
        .unwrap_or_default()
}

fn write_text(file: &Path, text: &str) -> Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(file, text)?;
    Ok(())
}

fn valid_term_id(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn term_id(v: &Value) -> Result<String> {
    match v {
        Value::Null => Ok("main".into()),
        Value::String(s) if valid_term_id(s) => Ok(s.clone()),
        _ => err("Invalid terminal id"),
    }
}

fn watch_repo(dir: &str) -> Watch {
    let (tx, _) = broadcast::channel(16);
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<()>();
    let root = PathBuf::from(dir);
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        let relevant = ev.paths.iter().any(|p| {
            let f = p.strip_prefix(&root).unwrap_or(p).to_string_lossy().replace('\\', "/");
            !(f.contains(".git/objects") || f.ends_with(".lock") || f.contains("node_modules"))
        });
        if relevant {
            let _ = ev_tx.send(());
        }
    })
    .ok()
    .and_then(|mut w| w.watch(Path::new(dir), notify::RecursiveMode::Recursive).ok().map(|_| w));
    let changed = tx.clone();
    tokio::spawn(async move {
        while ev_rx.recv().await.is_some() {
            // a burst of events becomes one "changed" after things settle
            loop {
                tokio::select! {
                    more = ev_rx.recv() => if more.is_none() { return },
                    _ = tokio::time::sleep(Duration::from_millis(400)) => break,
                }
            }
            let _ = changed.send(());
        }
    });
    Watch {
        tx,
        clients: AtomicUsize::new(0),
        _watcher: watcher,
    }
}

/// One client of a repository watch; the watch stops when the last client leaves.
struct WatchGuard {
    app: Arc<App>,
    repo: String,
    watch: Arc<Watch>,
}

impl Drop for WatchGuard {
    fn drop(&mut self) {
        let mut watchers = self.app.watchers.lock().unwrap();
        if self.watch.clients.fetch_sub(1, Ordering::SeqCst) == 1 && watchers.get(&self.repo).map(|w| Arc::ptr_eq(w, &self.watch)).unwrap_or(false) {
            watchers.remove(&self.repo);
        }
    }
}

/// The Keep awake switch in prefs.json: on unless the person turned it off.
fn keep_awake(prefs: &Value) -> bool {
    prefs.get("keepAwake").and_then(Value::as_bool) != Some(false)
}

impl App {
    pub fn new(cfg: Config) -> Arc<App> {
        let cwd = std::env::current_dir().unwrap_or_default();
        let cfg = Config {
            ui_dir: resolve(&cwd, &cfg.ui_dir),
            ..cfg
        };
        let app = Arc::new(App {
            known: Mutex::new(cfg.dir.iter().cloned().collect()),
            watchers: Default::default(),
            terms: Terminals::new(Some(cfg.state_file.with_file_name("terms"))),
            cfg,
        });
        if let Some(d) = &app.cfg.dir {
            let _ = app.remember(d);
        }
        app.terms.allow_wake(keep_awake(&app.prefs()));
        app
    }

    pub fn stop_agents(&self) {
        self.terms.stop_all();
        ai::kill_all();
    }

    fn beside(&self, name: &str) -> PathBuf {
        self.cfg.state_file.with_file_name(name)
    }

    fn prefs(&self) -> Value {
        std::fs::read_to_string(self.beside("prefs.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({}))
    }

    fn read_recent(&self) -> Vec<String> {
        read_list(&self.cfg.state_file)
    }

    fn remember(&self, repo: &str) -> Result<()> {
        let mut list = vec![repo.to_string()];
        list.extend(self.read_recent().into_iter().filter(|d| d != repo));
        list.truncate(12);
        write_text(&self.cfg.state_file, &serde_json::to_string(&list)?)
    }

    fn read_ai(&self) -> Value {
        let saved = std::fs::read_to_string(self.beside("ai.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);
        ai::clean_settings(&saved)
    }

    fn need_ai(&self) -> Result<()> {
        if self.read_ai()["enabled"] != true {
            return err("AI help is turned off");
        }
        Ok(())
    }

    fn watch(self: &Arc<Self>, repo: &str) -> WatchGuard {
        let mut watchers = self.watchers.lock().unwrap();
        let watch = watchers.entry(repo.to_string()).or_insert_with(|| Arc::new(watch_repo(repo))).clone();
        watch.clients.fetch_add(1, Ordering::SeqCst);
        WatchGuard {
            app: self.clone(),
            repo: repo.to_string(),
            watch,
        }
    }

    async fn shell(&self, name: &str, b: &Body<'_>) -> Result<Value> {
        let exists = |d: &String| Path::new(d).exists();
        match name {
            "repos" => Ok(json!({
                "current": self.cfg.dir.as_deref().map(info),
                "recent": self.read_recent().iter().filter(|d| exists(d)).map(|d| info(d)).collect::<Vec<_>>(),
            })),
            "pins" => Ok(Value::Array(read_list(&self.beside("pinned.json")).iter().filter(|d| exists(d)).map(|d| info(d)).collect())),
            "setPins" => {
                let dirs: Vec<String> = flat_strings(b.get("dirs")).into_iter().take(50).collect();
                write_text(&self.beside("pinned.json"), &serde_json::to_string(&dirs)?)?;
                done()
            }
            "prefs" => Ok(self.prefs()),
            "setPrefs" => {
                let p = b.get("prefs");
                let empty = json!({});
                let text = serde_json::to_string(if p.is_object() || p.is_array() { p } else { &empty })?;
                if text.len() > 20000 {
                    return err("Preferences are too large");
                }
                write_text(&self.beside("prefs.json"), &text)?;
                self.terms.allow_wake(keep_awake(p));
                done()
            }
            "findRepos" => {
                let at = self.cfg.dir.clone().unwrap_or_else(|| self.cfg.root.clone());
                let repos = if Path::new(&at) == home() { vec![] } else { git::find_repos(&at, 3, 100).await };
                Ok(json!({ "root": at, "inside": self.cfg.dir.is_some(), "repos": repos.iter().map(|d| info(d)).collect::<Vec<_>>() }))
            }
            "pickFolder" => Ok(git::pick_folder().await?.map(Value::String).unwrap_or(Value::Null)),
            "ai" => Ok(json!({ "agents": ai::detect(&self.cfg.env), "settings": self.read_ai() })),
            "setAi" => {
                write_text(&self.beside("ai.json"), &serde_json::to_string(&ai::clean_settings(b.get("settings")))?)?;
                done()
            }
            "openRepo" => {
                let raw = b.string("path");
                let raw = raw.trim();
                let expanded = if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
                    format!("{}{}", home().to_string_lossy(), &raw[1..])
                } else {
                    raw.to_string()
                };
                let base = self.cfg.dir.clone().unwrap_or_else(|| self.cfg.root.clone());
                let path = resolve(Path::new(&base), Path::new(&expanded));
                if !path.is_dir() {
                    return err("That folder does not exist");
                }
                let path = path.to_string_lossy().into_owned();
                // a folder without git opens too, for its terminals and to start a repository in it
                let top = match git::toplevel(&path).await {
                    Err(e) if e.0.contains("not a git repository") => path,
                    r => r?,
                };
                self.known.lock().unwrap().insert(top.clone());
                let _ = self.remember(&top);
                Ok(info(&top))
            }
            _ => err("unknown operation"),
        }
    }

    async fn op(&self, name: &str, repo: &str, b: &Body<'_>) -> Result<Value> {
        let env = &self.cfg.env;
        match name {
            "load" => val(git::load(repo, b.i64("limit").filter(|n| *n >= 0).map(|n| n as usize).unwrap_or(2000)).await?),
            "init" => git::run(repo, &["init"], None).await.and_then(|_| done()),
            "files" => val(git::files(repo).await?),
            "prs" => Ok(Value::Array(prs::pull_requests(repo, env).await)),
            "ciRuns" => Ok(Value::Array(prs::ci_runs(repo, env).await)),
            "prMerge" => prs::merge_pull_request(repo, b.i64("number").unwrap_or(0), &b.string("method"), env)
                .await
                .and_then(|_| done()),
            "prView" => prs::pull_request(repo, b.i64("number").unwrap_or(0), env).await,
            "prConversation" => prs::pr_conversation(repo, b.i64("number").unwrap_or(0), env).await,
            "prChange" => prs::change_pull_request(repo, b.i64("number").unwrap_or(0), &b.string("action"), env)
                .await
                .and_then(|_| done()),
            "status" => val(git::status(repo).await?),
            "commitFiles" => val(git::commit_files(repo, &b.string("oid")).await?),
            "fileVersions" => {
                let area: DiffArea = serde_json::from_value(b.get("area").clone())?;
                val(git::file_versions(repo, &area, &b.string("path")).await?)
            }
            "writeIndex" => git::write_index(repo, &b.string("path"), &b.string("content"), b.str("expected"))
                .await
                .and_then(|_| done()),
            "writeWorkdir" => git::write_workdir(repo, &b.string("path"), &b.string("content"), b.str("expected"))
                .await
                .and_then(|_| done()),
            "openPath" => git::open_path(repo, &b.string("path")).and_then(|_| done()),
            "revealPath" => git::reveal_path(repo, &b.string("path")).await.and_then(|_| done()),
            "stage" => git::stage(repo, &b.paths("paths")?).await.and_then(|_| done()),
            "unstage" => git::unstage(repo, &b.paths("paths")?).await.and_then(|_| done()),
            "discard" => {
                let files: Vec<FileChange> = serde_json::from_value(b.get("files").clone())?;
                git::discard(repo, &files).await.and_then(|_| done())
            }
            "commit" => git::commit(repo, &b.string("message"), b.truthy("amend")).await.and_then(|_| done()),
            "checkoutBranch" => git::checkout_branch(repo, &b.string("name")).await.and_then(|_| done()),
            "checkoutRemote" => val(git::checkout_remote(repo, &b.string("name")).await?),
            "checkoutCommit" => git::checkout_commit(repo, &b.string("oid")).await.and_then(|_| done()),
            "createBranch" => git::create_branch(repo, &b.string("name"), &b.string("at"), b.truthy("checkout"))
                .await
                .and_then(|_| done()),
            "deleteBranch" => git::delete_branch(repo, &b.string("name")).await.and_then(|_| done()),
            "deleteRemoteBranch" => git::delete_remote_branch(repo, &b.string("name")).await.and_then(|_| done()),
            "renameBranch" => git::rename_branch(repo, &b.string("oldName"), &b.string("newName")).await.and_then(|_| done()),
            "createTag" => git::create_tag(repo, &b.string("name"), &b.string("at"), b.str("message")).await.and_then(|_| done()),
            "deleteTag" => git::delete_tag(repo, &b.string("name")).await.and_then(|_| done()),
            "stashSave" => git::stash_save(repo, b.str("message")).await.and_then(|_| done()),
            "stashApply" => git::stash_apply(repo, b.i64("index").ok_or(Error("Invalid stash index".into()))?, b.truthy("pop"))
                .await
                .and_then(|_| done()),
            "stashDrop" => git::stash_drop(repo, b.i64("index").ok_or(Error("Invalid stash index".into()))?).await.and_then(|_| done()),
            "merge" => val(git::merge(repo, &b.string("branch")).await?),
            "rebase" => val(git::rebase(repo, &b.string("onto")).await?),
            "undoRebase" => val(git::undo_rebase(repo, &b.string("before")).await?),
            "dropAutostash" => git::drop_autostash(repo).await.and_then(|_| done()),
            "cherryPick" => val(git::cherry_pick(repo, &b.string("oid")).await?),
            "revert" => val(git::revert(repo, &b.string("oid")).await?),
            "reset" => git::reset(repo, &b.string("oid"), &b.string("mode")).await.and_then(|_| done()),
            "abort" => git::abort(repo).await.and_then(|_| done()),
            "continue" => git::continue_op(repo).await.and_then(|_| done()),
            "fetchAll" => git::fetch_all(repo).await.and_then(|_| done()),
            "pull" => git::pull(repo, &b.string("mode")).await.and_then(|_| done()),
            "push" => val(git::push(repo, b.str("lease").filter(|l| !l.is_empty())).await?),
            "aiContext" => val(git::ai_context(repo, &b.string("task"), b.str("at").filter(|a| !a.is_empty())).await?),
            "termStart" => {
                let kind = if b.str("kind") == Some("shell") { "shell" } else { "agent" };
                if kind == "agent" {
                    self.need_ai()?;
                }
                val(self.terms.start(
                    repo,
                    &term_id(b.get("id"))?,
                    kind,
                    &b.string("agent"),
                    b.i64("cols"),
                    b.i64("rows"),
                    b.str("resume").filter(|r| !r.is_empty()),
                    env,
                )?)
            }
            "termList" => val(self.terms.list(repo)),
            "agentSessions" => val(sessions::agent_sessions(repo, self.terms.held(repo), env).await),
            "termStop" => {
                if b.truthy("all") {
                    self.terms.stop(repo, None);
                } else {
                    self.terms.stop(repo, Some(&term_id(b.get("id"))?));
                }
                done()
            }
            "aiAsk" => {
                self.need_ai()?;
                val(ai::ask(&b.string("agent"), &b.string("prompt"), env, Duration::from_secs(300)).await?)
            }
            _ => err("unknown operation"),
        }
    }
}

fn json_status(status: u16, v: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")],
        v.to_string(),
    )
        .into_response()
}

fn local_host(host: &str) -> bool {
    let name = match host.rfind(':') {
        Some(i) if !host[i + 1..].is_empty() && host[i + 1..].chars().all(|c| c.is_ascii_digit()) => &host[..i],
        _ => host,
    };
    matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

async fn host_check(req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !local_host(host) {
        return (StatusCode::FORBIDDEN, "forbidden host").into_response();
    }
    next.run(req).await
}

async fn api(State(app): State<Arc<App>>, UrlPath(name): UrlPath<String>, method: Method, headers: HeaderMap, body: Bytes) -> Response {
    if headers.get("x-ramulus-token").and_then(|v| v.to_str().ok()) != Some(app.cfg.token.as_str()) {
        return json_status(401, json!({ "error": "bad token" }));
    }
    let shell = SHELL_OPS.contains(&name.as_str());
    if (!shell && !REPO_OPS.contains(&name.as_str())) || method != Method::POST {
        return json_status(404, json!({ "error": "unknown operation" }));
    }
    let result: Result<Value> = async {
        let body: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(&body)? };
        let b = Body(&body);
        if shell {
            return app.shell(&name, &b).await;
        }
        let repo = b.str("repo").map(str::to_string).or_else(|| app.cfg.dir.clone());
        let Some(repo) = repo.filter(|r| app.known.lock().unwrap().contains(r)) else {
            return err("Open that repository first");
        };
        app.op(&name, &repo, &b).await
    }
    .await;
    match result {
        Ok(v) => json_status(200, json!({ "result": v })),
        Err(e) => json_status(400, json!({ "error": e.0 })),
    }
}

fn stream_target(app: &App, q: &HashMap<String, String>) -> Option<String> {
    let repo = q.get("repo").filter(|r| !r.is_empty()).cloned().or_else(|| app.cfg.dir.clone())?;
    (q.get("token") == Some(&app.cfg.token) && app.known.lock().unwrap().contains(&repo)).then_some(repo)
}

async fn events(State(app): State<Arc<App>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(repo) = stream_target(&app, &q) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let guard = app.watch(&repo);
    let mut rx = guard.watch.tx.subscribe();
    let stream = async_stream::stream! {
        let _guard = guard;
        yield Ok::<_, Infallible>(Event::default().comment("connected"));
        while let Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) = rx.recv().await {
            yield Ok(Event::default().data("changed"));
        }
    };
    Sse::new(stream).into_response()
}

async fn term_socket(State(app): State<Arc<App>>, Query(q): Query<HashMap<String, String>>, ws: WebSocketUpgrade) -> Response {
    if q.get("token") != Some(&app.cfg.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| terminals(app, socket))
}

/// A tab the page attached on its socket: where its typing goes, and the task sending its output.
struct Channel {
    input: mpsc::UnboundedSender<String>,
    output: tokio::task::JoinHandle<()>,
}

/// One socket carries every terminal tab the page shows, each on a channel number the page picks: `attach` starts the
/// tab's output, `input` and `resize` go to it, `detach` ends it. Keystrokes stop waiting behind other requests.
async fn terminals(app: Arc<App>, mut socket: WebSocket) {
    let (tx, mut rx) = mpsc::channel::<String>(256);
    let mut chans: HashMap<u64, (String, String, Channel)> = HashMap::new();
    loop {
        let text = tokio::select! {
            Some(out) = rx.recv() => {
                if socket.send(Message::Text(out.into())).await.is_err() {
                    break;
                }
                continue;
            }
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(t))) => t,
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => continue,
            },
        };
        let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
        let b = Body(&v);
        let Some(ch) = b.i64("ch").and_then(|c| u64::try_from(c).ok()) else { continue };
        match b.str("op") {
            Some("attach") => {
                if let Some((.., old)) = chans.remove(&ch) {
                    old.output.abort();
                }
                let repo = b.str("repo").map(str::to_string).or_else(|| app.cfg.dir.clone());
                let (Some(repo), Ok(id)) = (repo.filter(|r| app.known.lock().unwrap().contains(r)), term_id(b.get("id"))) else {
                    if socket.send(Message::Text(json!({ "ch": ch, "exit": null }).to_string().into())).await.is_err() {
                        break;
                    }
                    continue;
                };
                // typing goes through its own queue, so a program that stops reading holds up only its own tab
                let (input, mut typed) = mpsc::unbounded_channel::<String>();
                let (a, r, i) = (app.clone(), repo.clone(), id.clone());
                tokio::spawn(async move {
                    while let Some(d) = typed.recv().await {
                        a.terms.write(&r, &i, d).await;
                    }
                });
                let (a, r, i, out) = (app.clone(), repo.clone(), id.clone(), tx.clone());
                let output = tokio::spawn(async move { a.terms.forward(&r, &i, ch, out).await });
                chans.insert(ch, (repo, id, Channel { input, output }));
            }
            Some("input") => {
                if let Some((.., c)) = chans.get(&ch) {
                    let _ = c.input.send(b.string("data"));
                }
            }
            Some("resize") => {
                if let Some((repo, id, _)) = chans.get(&ch) {
                    app.terms.resize(repo, id, b.i64("cols"), b.i64("rows"));
                }
            }
            Some("detach") => {
                if let Some((.., c)) = chans.remove(&ch) {
                    c.output.abort();
                }
            }
            _ => {}
        }
    }
    for (.., c) in chans.into_values() {
        c.output.abort();
    }
}

async fn static_file(State(app): State<Arc<App>>, req: Request) -> Response {
    let path = req.uri().path();
    let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    let ui = &app.cfg.ui_dir;
    let file = resolve(ui, Path::new(rel));
    if file == *ui || !file.starts_with(ui) || !file.is_file() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let ctype = match file.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    };
    match tokio::fs::read(&file).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, ctype), (header::CACHE_CONTROL, "no-cache")], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/events", get(events))
        .route("/api/term", get(term_socket))
        .route("/api/{op}", any(api))
        .fallback(static_file)
        .layer(middleware::from_fn(host_check))
        // edits send a file and its expected contents in one body; 64 MB covers the 2 MB text limit after JSON escaping
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(app)
}

pub async fn serve(app: Arc<App>, listener: tokio::net::TcpListener) -> std::io::Result<()> {
    axum::serve(listener, router(app)).await
}
