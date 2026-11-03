use crate::{err, var, Env, Error, Result};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub struct Agent {
    pub id: &'static str,
    pub name: &'static str,
    pub bin: &'static str,
}

pub const AGENTS: [Agent; 4] = [
    Agent {
        id: "claude",
        name: "Claude Code",
        bin: "claude",
    },
    Agent {
        id: "codex",
        name: "Codex",
        bin: "codex",
    },
    Agent {
        id: "gemini",
        name: "Gemini CLI",
        bin: "gemini",
    },
    Agent {
        id: "opencode",
        name: "opencode",
        bin: "opencode",
    },
];

impl Agent {
    fn args(&self, out: &str) -> Vec<String> {
        let list: &[&str] = match self.id {
            "claude" => &[
                "-p",
                "--output-format",
                "text",
                "--no-session-persistence",
                "--tools",
                "",
                "--strict-mcp-config",
                "--disable-slash-commands",
            ],
            "codex" => &["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--output-last-message", out, "-"],
            "opencode" => &["run", "--agent", "plan"],
            _ => &[],
        };
        list.iter().map(|s| s.to_string()).collect()
    }
}

pub fn agent(id: &str) -> Option<&'static Agent> {
    AGENTS.iter().find(|a| a.id == id)
}

pub const PROMPT_TASKS: [&str; 3] = ["commit", "branch", "conflict"];

static RUNNING: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Stops every draft still running, for when the helper quits.
pub fn kill_all() {
    let pids: Vec<u32> = RUNNING.lock().unwrap().clone();
    for pid in pids {
        kill_group(pid);
    }
}

fn kill_group(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .creation_flags(crate::NO_WINDOW)
            .spawn();
    }
}

pub fn find_bin(bin: &str, env: &Env) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        var(env, "PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD").split(';').map(String::from).collect()
    } else {
        vec![String::new()]
    };
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in var(env, "PATH").unwrap_or("").split(sep).filter(|d| !d.is_empty()) {
        for ext in &exts {
            let file = Path::new(dir).join(format!("{bin}{ext}"));
            if file.is_file() {
                return Some(file);
            }
        }
    }
    None
}

pub fn detect(env: &Env) -> Vec<Value> {
    AGENTS
        .iter()
        .filter(|a| find_bin(a.bin, env).is_some())
        .map(|a| json!({ "id": a.id, "name": a.name }))
        .collect()
}

pub fn clean_settings(s: &Value) -> Value {
    let mut out = Map::new();
    if let Some(enabled) = s["enabled"].as_bool() {
        out.insert("enabled".into(), Value::Bool(enabled));
    }
    if let Some(a) = s["agent"].as_str().filter(|a| agent(a).is_some()) {
        out.insert("agent".into(), Value::String(a.into()));
    }
    let mut prompts = Map::new();
    if let Some(p) = s["prompts"].as_object() {
        for (k, v) in p {
            if let Some(t) = v.as_str().filter(|t| PROMPT_TASKS.contains(&k.as_str()) && !t.trim().is_empty()) {
                prompts.insert(k.clone(), Value::String(t.chars().take(4000).collect()));
            }
        }
    }
    out.insert("prompts".into(), Value::Object(prompts));
    Value::Object(out)
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            let mut ahead = chars.clone();
            ahead.next();
            while matches!(ahead.peek(), Some(d) if d.is_ascii_digit() || *d == ';') {
                ahead.next();
            }
            if ahead.peek() == Some(&'m') {
                ahead.next();
                chars = ahead;
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// The raw text of the first `"message": "..."` in the line, as the JSON has it.
fn extract_message(line: &str) -> Option<String> {
    let rest = line[line.find("\"message\"")? + 9..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let mut out = String::new();
    let mut cs = rest.chars();
    while let Some(c) = cs.next() {
        match c {
            '"' => return Some(out),
            '\\' => {
                out.push(c);
                out.extend(cs.next());
            }
            _ => out.push(c),
        }
    }
    None
}

fn reason(stderr: &str, name: &str) -> String {
    let clean = strip_ansi(stderr);
    let line = clean.trim().split('\n').rfind(|l: &&str| !l.trim().is_empty()).unwrap_or("");
    let message = extract_message(line).unwrap_or_else(|| line.trim().to_string());
    if message.is_empty() {
        format!("{name} stopped without a reply")
    } else {
        format!("{name}: {}", message.chars().take(500).collect::<String>())
    }
}

fn tail_chars(s: &str, n: usize) -> String {
    let skip = s.chars().count().saturating_sub(n);
    s.chars().skip(skip).collect()
}

fn mkdtemp(prefix: &str) -> Result<PathBuf> {
    loop {
        let mut b = [0u8; 6];
        getrandom::fill(&mut b).map_err(|e| Error(e.to_string()))?;
        let name: String = b.iter().map(|x| format!("{x:02x}")).collect();
        let p = std::env::temp_dir().join(format!("{prefix}{name}"));
        match std::fs::create_dir(&p) {
            Ok(()) => return Ok(p),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
}

fn cleanup(tmp: PathBuf) {
    tokio::spawn(async move {
        for _ in 0..10 {
            if tokio::fs::remove_dir_all(&tmp).await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
}

/// Tracks a running draft; dropping it while armed stops the agent and everything it started.
struct Running {
    pid: u32,
    armed: bool,
}

impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.lock().unwrap().retain(|p| *p != self.pid);
        if self.armed {
            kill_group(self.pid);
        }
    }
}

/// Asks the agent once, with the prompt on stdin, and returns its reply. Dropping the future stops the agent.
pub async fn ask(id: &str, prompt: &str, env: &Env, timeout: Duration) -> Result<String> {
    let found = agent(id).and_then(|a| find_bin(a.bin, env).map(|bin| (a, bin)));
    let Some((agent, bin)) = found else { return err("That AI agent is not installed") };
    let tmp = mkdtemp("ramulus-ai-")?;
    let result = ask_in(agent, &bin, prompt, env, timeout, &tmp).await;
    cleanup(tmp);
    result
}

async fn ask_in(agent: &Agent, bin: &Path, prompt: &str, env: &Env, timeout: Duration, tmp: &Path) -> Result<String> {
    let out = tmp.join("reply.txt");
    let mut cmd = Command::new(bin);
    cmd.args(agent.args(&out.to_string_lossy())).current_dir(tmp).env_clear().envs(env);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(crate::NO_WINDOW);
    let mut child = cmd.spawn()?;
    let mut running = Running {
        pid: child.id().unwrap_or(0),
        armed: true,
    };
    RUNNING.lock().unwrap().push(running.pid);
    let stdin = child.stdin.take();
    let prompt = prompt.as_bytes().to_vec();
    let feed = async move {
        if let Some(mut s) = stdin {
            let _ = s.write_all(&prompt).await;
        }
    };
    let waited = tokio::time::timeout(timeout, async {
        let (o, ()) = tokio::join!(child.wait_with_output(), feed);
        o
    })
    .await;
    let Ok(output) = waited else {
        return err(format!("{} did not answer within {} minutes", agent.name, (timeout.as_secs_f64() / 60.0).round()));
    };
    let output = output?;
    running.armed = false;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = tail_chars(&String::from_utf8_lossy(&output.stderr), 8000);
    let reply = tokio::fs::read_to_string(&out).await.unwrap_or(stdout).trim().to_string();
    if !output.status.success() || reply.is_empty() {
        return err(reason(&stderr, agent.name));
    }
    Ok(reply)
}
