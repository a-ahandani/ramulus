use crate::ai::find_bin;
use crate::{err, var, Env, Error, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::process::Command;

const FRESH: Duration = Duration::from_secs(60);
const VIEW_FRESH: Duration = Duration::from_secs(20);
const FIELDS: &str = "number,title,url,headRefName,headRefOid,baseRefName,state,isDraft";
const VIEW_FIELDS: &str = "number,title,body,state,isDraft,author,headRefName,baseRefName,url,createdAt,reviewDecision,mergeStateStatus,statusCheckRollup";
const METHODS: [&str; 3] = ["merge", "squash", "rebase"];

type Cached<T> = LazyLock<Mutex<HashMap<String, (Instant, T)>>>;
static CACHE: Cached<Vec<Value>> = LazyLock::new(Default::default);
static VIEWS: Cached<Value> = LazyLock::new(Default::default);

async fn gh(bin: &Path, args: &[String], dir: &str, env: &Env) -> Result<String> {
    let mut cmd = Command::new(bin);
    cmd.args(args).current_dir(dir).env_clear().envs(env).env("GH_PROMPT_DISABLED", "1");
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(crate::NO_WINDOW);
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| Error("gh did not answer within a minute".into()))??;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
    err(if e.is_empty() { format!("gh exited with {}", out.status) } else { e })
}

fn auth_problem(m: &str) -> bool {
    let l = m.to_lowercase();
    l.contains("401") || l.contains("403") || l.contains("bad credentials") || l.contains("not accessible") || l.contains("authenticat")
}

fn is_token(k: &str) -> bool {
    if cfg!(windows) {
        k.eq_ignore_ascii_case("GITHUB_TOKEN") || k.eq_ignore_ascii_case("GH_TOKEN")
    } else {
        k == "GITHUB_TOKEN" || k == "GH_TOKEN"
    }
}

/// Runs gh; when a token in the environment is what GitHub rejects, retries with the user's own gh sign-in.
async fn gh_signed_in(args: &[String], dir: &str, env: &Env) -> Result<String> {
    let Some(bin) = find_bin("gh", env) else {
        return err("The GitHub CLI (gh) is not installed");
    };
    let has_token = [var(env, "GITHUB_TOKEN"), var(env, "GH_TOKEN")].iter().any(|v| v.map(|s| !s.is_empty()).unwrap_or(false));
    match gh(&bin, args, dir, env).await {
        Err(e) if has_token && auth_problem(&e.0) => {
            let signed_in: Env = env.iter().filter(|(k, _)| !is_token(k)).map(|(k, v)| (k.clone(), v.clone())).collect();
            gh(&bin, args, dir, &signed_in).await
        }
        r => r,
    }
}

fn strs(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn state(v: &Value) -> Value {
    if v["state"] == "OPEN" && v["isDraft"] == true {
        json!("DRAFT")
    } else {
        v["state"].clone()
    }
}

async fn load(dir: &str, env: &Env) -> Vec<Value> {
    let Ok(out) = gh_signed_in(&strs(&["pr", "list", "--state", "all", "--limit", "100", "--json", FIELDS]), dir, env).await else {
        return vec![];
    };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&out) else { return vec![] };
    items
        .iter()
        .map(|p| json!({ "number": p["number"], "title": p["title"], "url": p["url"], "branch": p["headRefName"], "oid": p["headRefOid"], "base": p["baseRefName"], "state": state(p) }))
        .collect()
}

pub async fn pull_requests(dir: &str, env: &Env) -> Vec<Value> {
    if let Some((at, list)) = CACHE.lock().unwrap().get(dir) {
        if at.elapsed() < FRESH {
            return list.clone();
        }
    }
    let at = Instant::now();
    let list = load(dir, env).await;
    CACHE.lock().unwrap().insert(dir.to_string(), (at, list.clone()));
    list
}

fn check_state(c: &Value) -> &'static str {
    if c["__typename"] == "StatusContext" {
        return match c["state"].as_str() {
            Some("SUCCESS") => "pass",
            Some("FAILURE" | "ERROR") => "fail",
            _ => "running",
        };
    }
    if c["status"] != "COMPLETED" {
        return "running";
    }
    match c["conclusion"].as_str() {
        Some("SUCCESS") => "pass",
        Some("FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE") => "fail",
        Some("CANCELLED") => "cancelled",
        _ => "skipped",
    }
}

fn who(a: &Value) -> &str {
    a["login"].as_str().unwrap_or("unknown")
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

fn first<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if a.is_null() {
        b
    } else {
        a
    }
}

async fn fresh<F: Future<Output = Result<Value>>>(key: String, number: i64, read: impl FnOnce() -> F) -> Result<Value> {
    if number < 1 {
        return err("Invalid pull request number");
    }
    if let Some((at, v)) = VIEWS.lock().unwrap().get(&key) {
        if at.elapsed() < VIEW_FRESH {
            return Ok(v.clone());
        }
    }
    let at = Instant::now();
    let v = read().await?;
    VIEWS.lock().unwrap().insert(key, (at, v.clone()));
    Ok(v)
}

pub async fn pull_request(dir: &str, number: i64, env: &Env) -> Result<Value> {
    fresh(format!("{dir}\n{number}"), number, || read_pull_request(dir, number, env)).await
}

pub async fn pr_conversation(dir: &str, number: i64, env: &Env) -> Result<Value> {
    fresh(format!("{dir}\n{number}\nconversation"), number, || read_conversation(dir, number, env)).await
}

async fn read_pull_request(dir: &str, number: i64, env: &Env) -> Result<Value> {
    let v: Value = serde_json::from_str(&gh_signed_in(&strs(&["pr", "view", &number.to_string(), "--json", VIEW_FIELDS]), dir, env).await?)?;
    let checks: Vec<Value> = v["statusCheckRollup"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| {
                    json!({
                        "name": c["name"].as_str().or(c["context"].as_str()).unwrap_or("Check"),
                        "workflow": text(c, "workflowName"),
                        "state": check_state(c),
                        "url": c["detailsUrl"].as_str().or(c["targetUrl"].as_str()).unwrap_or(""),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "number": v["number"], "title": v["title"], "body": text(&v, "body"), "url": v["url"], "state": state(&v),
        "author": who(&v["author"]), "head": v["headRefName"], "base": v["baseRefName"], "createdAt": v["createdAt"],
        "reviewDecision": text(&v, "reviewDecision"), "mergeState": text(&v, "mergeStateStatus"), "checks": checks,
    }))
}

const NOTE: &str = "id body bodyHTML url author{__typename login avatarUrl(size:56)}";

// shortcut: reads the newest 100 of each list and 50 replies per thread, page through them if a pull request outgrows that.
fn conversation_query() -> String {
    format!(
        "query($owner:String!,$name:String!,$number:Int!){{repository(owner:$owner,name:$name){{pullRequest(number:$number){{
  body
  bodyHTML
  author{{avatarUrl(size:56)}}
  comments(last:100){{nodes{{{NOTE} createdAt}}}}
  reviews(last:100){{nodes{{{NOTE} state submittedAt}}}}
  reviewThreads(last:100){{nodes{{id path line startLine originalLine originalStartLine isResolved isOutdated comments(first:50){{nodes{{{NOTE} createdAt diffHunk}}}}}}}}
}}}}}}"
    )
}

fn note(n: &Value) -> Value {
    json!({
        "id": n["id"], "author": who(&n["author"]), "avatar": text(&n["author"], "avatarUrl"), "bot": n["author"]["__typename"] == "Bot",
        "text": text(n, "body"), "html": text(n, "bodyHTML"), "url": n["url"], "at": first(&n["createdAt"], &n["submittedAt"]),
    })
}

fn nodes(v: &Value) -> Vec<Value> {
    v["nodes"].as_array().cloned().unwrap_or_default()
}

async fn read_conversation(dir: &str, number: i64, env: &Env) -> Result<Value> {
    let pr = pull_request(dir, number, env).await?;
    let url = text(&pr, "url");
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let (hostname, pathname) = rest.split_once('/').unwrap_or((rest, ""));
    let mut segs = pathname.split('/');
    let (owner, name) = (segs.next().unwrap_or(""), segs.next().unwrap_or(""));
    let query = format!("query={}", conversation_query());
    let args = strs(&[
        "api",
        "graphql",
        "--hostname",
        hostname,
        "-f",
        &query,
        "-f",
        &format!("owner={owner}"),
        "-f",
        &format!("name={name}"),
        "-F",
        &format!("number={number}"),
    ]);
    let out: Value = serde_json::from_str(&gh_signed_in(&args, dir, env).await?)?;
    let pr = &out["data"]["repository"]["pullRequest"];
    let reviews: Vec<Value> = nodes(&pr["reviews"])
        .iter()
        // A COMMENTED review with no text only wraps its inline comments, which already show as threads.
        .filter(|r| r["state"] != "PENDING" && (r["state"] != "COMMENTED" || !text(r, "body").trim().is_empty()))
        .map(|r| {
            let mut n = note(r);
            n["state"] = r["state"].clone();
            n
        })
        .collect();
    let threads: Vec<Value> = nodes(&pr["reviewThreads"])
        .iter()
        .filter_map(|t| {
            let cs = nodes(&t["comments"]);
            let first_comment = cs.first()?;
            Some(json!({
                "id": t["id"], "path": t["path"], "line": first(&t["line"], &t["originalLine"]), "startLine": first(&t["startLine"], &t["originalStartLine"]),
                "resolved": t["isResolved"], "outdated": t["isOutdated"], "hunk": text(first_comment, "diffHunk"), "notes": cs.iter().map(note).collect::<Vec<_>>(),
            }))
        })
        .collect();
    Ok(json!({
        "text": text(pr, "body"), "html": text(pr, "bodyHTML"), "avatar": text(&pr["author"], "avatarUrl"),
        "comments": nodes(&pr["comments"]).iter().map(note).collect::<Vec<_>>(), "reviews": reviews, "threads": threads,
    }))
}

fn forget(dir: &str) {
    CACHE.lock().unwrap().remove(dir);
    let prefix = format!("{dir}\n");
    VIEWS.lock().unwrap().retain(|k, _| !k.starts_with(&prefix));
}

pub async fn change_pull_request(dir: &str, number: i64, action: &str, env: &Env) -> Result<()> {
    if number < 1 {
        return err("Invalid pull request number");
    }
    let flags: &[&str] = match action {
        "ready" => &["ready"],
        "draft" => &["ready", "--undo"],
        "close" => &["close"],
        "reopen" => &["reopen"],
        _ => return err("Invalid pull request action"),
    };
    let mut args = strs(&["pr", flags[0], &number.to_string()]);
    args.extend(strs(&flags[1..]));
    let r = gh_signed_in(&args, dir, env).await.map(drop);
    forget(dir);
    r
}

pub async fn merge_pull_request(dir: &str, number: i64, method: &str, env: &Env) -> Result<()> {
    if number < 1 {
        return err("Invalid pull request number");
    }
    if !METHODS.contains(&method) {
        return err("Invalid merge method");
    }
    let r = gh_signed_in(&strs(&["pr", "merge", &number.to_string(), &format!("--{method}")]), dir, env).await.map(drop);
    forget(dir);
    r
}
