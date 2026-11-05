//! The agent conversations held in a folder that no tab has open: the ones a new tab can go back to.
use crate::ai::find_bin;
use crate::term::{clean_title, valid_session_id, Held};
use crate::{home, var, Env};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tokio::process::Command;

const MAX: usize = 50;
const CHUNK: u64 = 65536;
/// Codex writes the first prompt after its instructions, which can be a few hundred KB into the file.
const HEAD_MAX: u64 = 1 << 20;

#[derive(Serialize, Debug, PartialEq)]
pub struct AgentSession {
    pub agent: &'static str,
    pub id: String,
    pub title: String,
    pub time: i64,
    #[serde(flatten)]
    pub usage: Usage,
}

/// What the last request carried, the model's window when the agent records it, every token of the conversation, and its cost in USD.
#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Clone)]
struct Info {
    cwd: String,
    /// Codex's own id; Claude Code names the file after it
    id: String,
    title: Option<String>,
    /// None until read: Codex's is read only for the folder's own conversations
    usage: Option<Usage>,
}

/// What each session file held when it was last read, by path, with the size and time it had then.
type Cache = HashMap<PathBuf, (u64, i64, Option<Info>)>;
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);

fn read_at(file: &Path, pos: u64, len: u64) -> std::io::Result<String> {
    let mut f = std::fs::File::open(file)?;
    f.seek(SeekFrom::Start(pos))?;
    let mut buf = Vec::new();
    f.take(len).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Whole JSON lines only: a chunk that starts or ends inside a line drops that piece.
fn lines(text: &str, cut_start: bool, cut_end: bool) -> Vec<Value> {
    let mut all: Vec<&str> = text.split('\n').collect();
    if cut_start {
        all.remove(0);
    }
    if cut_end {
        all.pop();
    }
    all.into_iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.is_object() || v.is_array())
        .collect()
}

/// A token count as both helpers read it: a whole number, or nothing.
fn count(v: Option<&Value>) -> Option<u64> {
    v?.as_f64().filter(|f| *f >= 0.0 && f.fract() == 0.0).map(|f| f as u64)
}

/// The end of a file: the last CHUNK, or up to HEAD_MAX when `has` finds nothing there.
fn tail(file: &Path, size: u64, has: fn(&Value) -> bool) -> Option<Vec<Value>> {
    if size <= CHUNK {
        return Some(lines(&read_at(file, 0, CHUNK).ok()?, false, false));
    }
    let end = lines(&read_at(file, size - CHUNK, CHUNK).ok()?, true, false);
    if end.iter().any(has) {
        return Some(end);
    }
    let at = size.saturating_sub(HEAD_MAX);
    Some(lines(&read_at(file, at, HEAD_MAX).ok()?, at > 0, false))
}

fn claude_reply(o: &Value) -> bool {
    str_at(o, &["type"]) == Some("assistant") && o.get("isSidechain") != Some(&Value::Bool(true)) && o.get("message").and_then(|m| m.get("usage")).is_some_and(Value::is_object)
}

/// What Claude Code's last request carried, and what the conversation has cost (a running total it writes as it goes).
fn claude_usage(end: &[Value]) -> Usage {
    let u = end.iter().rev().find(|o| claude_reply(o)).map(|o| &o["message"]["usage"]);
    let context = u.map(|u| {
        ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
            .iter()
            .map(|k| count(u.get(k)).unwrap_or(0))
            .sum::<u64>()
    });
    let cost = end.iter().rev().find_map(|o| {
        if str_at(o, &["type"]) == Some("cost-state") {
            o.get("totalCostUSD")?.as_f64().filter(|c| *c >= 0.0)
        } else {
            None
        }
    });
    Usage {
        context: context.filter(|c| *c > 0),
        // in cents, since the two helpers read the last digits of a long decimal differently
        cost: cost.map(|c| (c * 100.0).round() / 100.0),
        ..Default::default()
    }
}

fn codex_count(o: &Value) -> bool {
    str_at(o, &["type"]) == Some("event_msg") && str_at(o, &["payload", "type"]) == Some("token_count") && o["payload"].get("info").is_some_and(Value::is_object)
}

/// What Codex's last request carried, out of the model's window, and every token of the conversation.
fn codex_usage(file: &Path, size: u64) -> Usage {
    let end = tail(file, size, codex_count).unwrap_or_default();
    let info = end.iter().rev().find(|o| codex_count(o)).map(|o| &o["payload"]["info"]);
    Usage {
        context: count(info.and_then(|i| i.get("last_token_usage")?.get("input_tokens"))),
        window: count(info.and_then(|i| i.get("model_context_window"))),
        tokens: count(info.and_then(|i| i.get("total_token_usage")?.get("total_tokens"))),
        cost: None,
    }
}

fn one_line(s: Option<&str>) -> Option<String> {
    let words: Vec<&str> = s?.split(['\t', '\n', '\r', ' ']).filter(|w| !w.is_empty()).collect();
    clean_title(&words.join(" "))
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |v, k| v.get(k))?.as_str()
}

/// The files that exist, with their size and last change, newest first.
fn newest(files: Vec<PathBuf>) -> Vec<(PathBuf, u64, i64)> {
    let mut out: Vec<(PathBuf, u64, i64)> = files
        .into_iter()
        .filter_map(|f| {
            let m = std::fs::metadata(&f).ok().filter(|m| m.is_file())?;
            let time = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
            Some((f, m.len(), time))
        })
        .collect();
    // the same order in both helpers when two files changed in the same millisecond
    out.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.as_os_str().cmp(b.0.as_os_str())));
    out
}

fn cached(f: &(PathBuf, u64, i64), read: impl Fn(&Path, u64) -> Option<Info>) -> Option<Info> {
    if let Some((size, time, info)) = CACHE.lock().unwrap().get(&f.0) {
        if *size == f.1 && *time == f.2 {
            return info.clone();
        }
    }
    let info = read(&f.0, f.1);
    CACHE.lock().unwrap().insert(f.0.clone(), (f.1, f.2, info.clone()));
    info
}

/// Git names a Windows folder C:/a/b, and the agents C:\a\b; Windows folder names ignore case.
fn same(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.replace('\\', "/").to_lowercase() == b.replace('\\', "/").to_lowercase()
    } else {
        a == b
    }
}

fn user_text(o: &Value) -> Option<&str> {
    if str_at(o, &["type"]) != Some("user") || o.get("isMeta") == Some(&Value::Bool(true)) || str_at(o, &["message", "role"]) != Some("user") {
        return None;
    }
    let c = o.get("message")?.get("content")?;
    let text = match c {
        Value::String(s) => s.as_str(),
        Value::Array(blocks) => blocks.iter().find(|b| str_at(b, &["type"]) == Some("text"))?.get("text")?.as_str()?,
        _ => return None,
    };
    (!text.is_empty() && !text.starts_with('<')).then_some(text)
}

/// Claude Code notes each running conversation in sessions/<pid>.json, which a crash leaves behind, so the process must still run.
fn claude_running(base: &Path) -> Vec<String> {
    // shortcut: Windows has no process check both helpers share, so conversations running outside Ramulus show there; add one if that bites
    #[cfg(unix)]
    {
        let alive = |pid: i32| unsafe { libc::kill(pid, 0) == 0 } || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        std::fs::read_dir(base.join("sessions"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let digits = name.strip_suffix(".json").filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))?;
                digits.parse::<i32>().ok().filter(|p| *p > 0 && alive(*p))?;
                let o: Value = serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
                Some(o.get("sessionId")?.as_str()?.to_string())
            })
            .collect()
    }
    #[cfg(not(unix))]
    {
        let _ = base;
        vec![]
    }
}

/// Claude Code keeps a folder's conversations in one directory named after the folder, and names each one as it goes.
fn claude(repo: &str, env: &Env) -> Vec<AgentSession> {
    let base = var(env, "CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".claude"));
    // the way Claude Code (in JavaScript) names it: every UTF-16 unit that is not a letter or digit becomes a dash
    let name: String = repo
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_string() } else { "-".repeat(c.len_utf16()) })
        .collect();
    let dir = base.join("projects").join(name);
    let running = claude_running(&base);
    let files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            n.len() == 42 && n.to_ascii_lowercase().ends_with(".jsonl") && n.get(..36).is_some_and(|id| id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        })
        .collect();
    let mut out = vec![];
    for f in newest(files) {
        let info = cached(&f, |file, size| {
            let head = lines(&read_at(file, 0, CHUNK).ok()?, false, size > CHUNK);
            let end = tail(file, size, claude_reply)?;
            let titled = head
                .iter()
                .chain(&end)
                .rev()
                .filter(|o| str_at(o, &["type"]) == Some("ai-title"))
                .find_map(|o| str_at(o, &["aiTitle"]));
            Some(Info {
                cwd: head.iter().find_map(|o| str_at(o, &["cwd"]))?.to_string(),
                id: String::new(),
                title: one_line(titled).or_else(|| one_line(head.iter().find_map(user_text))),
                usage: Some(claude_usage(&end)),
            })
        });
        let id = f.0.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        // two folders can share a directory name, so the folder the conversation names decides
        if let Some(Info {
            cwd, title: Some(title), usage, ..
        }) = info
        {
            if same(&cwd, repo) && !running.contains(&id) {
                out.push(AgentSession {
                    agent: "claude",
                    id,
                    title,
                    time: f.2,
                    usage: usage.unwrap_or_default(),
                });
            }
        }
        if out.len() >= MAX {
            break;
        }
    }
    out
}

fn codex_info(file: &Path, size: u64) -> Option<Info> {
    let mut head = lines(&read_at(file, 0, CHUNK).ok()?, false, size > CHUNK);
    let meta = head.first().filter(|o| str_at(o, &["type"]) == Some("session_meta"))?.get("payload")?.clone();
    // sessions run by other programs (exec) and subagents (an object) are not conversations to go back to
    if str_at(&meta, &["source"]).is_none_or(|s| s == "exec") {
        return None;
    }
    let prompt = |o: &Value| -> Option<String> {
        let m = str_at(o, &["payload", "message"]).filter(|m| !m.is_empty())?;
        (str_at(o, &["type"]) == Some("event_msg") && str_at(o, &["payload", "type"]) == Some("user_message")).then(|| m.to_string())
    };
    if !head.iter().any(|o| prompt(o).is_some()) && size > CHUNK {
        head = lines(&read_at(file, 0, HEAD_MAX).ok()?, false, size > HEAD_MAX);
    }
    // the VS Code extension puts the open files before what was asked
    let asked = head.iter().find_map(prompt);
    Some(Info {
        cwd: str_at(&meta, &["cwd"])?.to_string(),
        id: str_at(&meta, &["id"])?.to_string(),
        title: one_line(asked.as_deref().and_then(|a| a.rsplit("## My request for Codex:").next())),
        usage: None,
    })
}

/// Codex keeps every conversation by date and names some of them in an index beside them.
fn codex(repo: &str, env: &Env) -> Vec<AgentSession> {
    let base = var(env, "CODEX_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(".codex"));
    let mut names: HashMap<String, Option<String>> = HashMap::new();
    for o in lines(&std::fs::read_to_string(base.join("session_index.jsonl")).unwrap_or_default(), false, false) {
        if let Some(id) = str_at(&o, &["id"]) {
            names.insert(id.to_string(), str_at(&o, &["thread_name"]).map(String::from));
        }
    }
    fn walk(dir: &Path, depth: u8, files: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let Ok(t) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            if depth < 3 && t.is_dir() {
                walk(&e.path(), depth + 1, files);
            } else if depth == 3 && t.is_file() && name.starts_with("rollout-") && name.ends_with(".jsonl") {
                files.push(e.path());
            }
        }
    }
    let mut files = vec![];
    walk(&base.join("sessions"), 0, &mut files);
    let mut out = vec![];
    for f in newest(files) {
        let Some(info) = cached(&f, codex_info).filter(|i| same(&i.cwd, repo)) else { continue };
        let Some(title) = one_line(names.get(&info.id).and_then(|n| n.as_deref())).or(info.title) else {
            continue;
        };
        // read once for each version of the file, and only for this folder's conversations
        let usage = info.usage.unwrap_or_else(|| {
            let u = codex_usage(&f.0, f.1);
            if let Some((_, _, Some(i))) = CACHE.lock().unwrap().get_mut(&f.0) {
                i.usage = Some(u.clone());
            }
            u
        });
        out.push(AgentSession {
            agent: "codex",
            id: info.id,
            title,
            time: f.2,
            usage,
        });
        if out.len() >= MAX {
            break;
        }
    }
    out
}

/// opencode keeps its conversations in a database, so it is asked for them.
async fn opencode(repo: String, env: Env) -> Vec<AgentSession> {
    let Some(bin) = find_bin("opencode", &env) else { return vec![] };
    let mut cmd = Command::new(bin);
    cmd.args(["session", "list", "--format", "json"]).current_dir(&repo).env_clear().envs(&env);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(crate::NO_WINDOW);
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await else {
        return vec![];
    };
    if !out.status.success() {
        return vec![];
    }
    let list = match serde_json::from_slice::<Value>(&out.stdout) {
        Ok(Value::Array(a)) => a,
        Ok(v) => vec![v],
        Err(_) => vec![],
    };
    list.iter()
        .filter_map(|s| {
            let title = one_line(str_at(s, &["title"]))?;
            str_at(s, &["directory"]).filter(|d| same(d, &repo))?;
            let time = s.get("updated").and_then(Value::as_f64).map(|t| t.floor() as i64).unwrap_or(0);
            Some(AgentSession {
                agent: "opencode",
                id: str_at(s, &["id"])?.to_string(),
                title,
                time,
                usage: Usage::default(),
            })
        })
        .collect()
}

/// The agent conversations held in `repo` that no tab has open, newest first: the ones to go back to.
/// `held` says which sessions the folder's tabs have open (see `Terminals::held`).
pub async fn agent_sessions(repo: &str, held: Held, env: &Env) -> Vec<AgentSession> {
    let asked = tokio::spawn(opencode(repo.to_string(), env.clone()));
    let on = |bin| find_bin(bin, env).is_some();
    let mut all = if on("claude") { claude(repo, env) } else { vec![] };
    if on("codex") {
        all.extend(codex(repo, env));
    }
    all.extend(asked.await.unwrap_or_default());
    all.retain(|s| valid_session_id(&s.id) && !held.ids.contains(&s.id) && held.since.get(s.agent).is_none_or(|since| s.time < *since));
    all.sort_by_key(|s| std::cmp::Reverse(s.time));
    all.truncate(MAX);
    all
}
