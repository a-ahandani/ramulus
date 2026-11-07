mod common;
use common::*;
use serde_json::json;
use std::path::Path;

fn repo(root: &Path, name: &str) -> std::path::PathBuf {
    let d = root.join(name);
    git(root, &["init", "-q", "-b", "main", s(&d)]);
    toplevel(&d)
}

fn names(v: &serde_json::Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap().to_string()).collect()
}

#[test]
fn starts_outside_a_repository_and_lists_the_repositories_below_it() {
    let root = tmp("ramulus-srv-");
    repo(&root, "first");
    let second = repo(&root, "second");
    for skipped in ["x/node_modules/dep", ".hidden/y", "a/b/c/d"] {
        git(&root, &["init", "-q", s(&root.join(skipped))]);
    }
    let srv = Server::start(config(None, &root, &root.join("state")));
    assert!(srv.result("repos", json!({}))["current"].is_null());
    assert_eq!(names(&srv.result("findRepos", json!({}))["repos"]), ["first", "second"]);
    assert!(srv.error("status", json!({})).contains("Open that repository first"));
    assert_eq!(srv.result("openRepo", json!({ "path": "./second" }))["name"], "second");
    assert_eq!(srv.result("status", json!({ "repo": second }))["unstaged"], json!([]));
}

#[test]
fn offers_the_repositories_nested_inside_the_one_it_started_in() {
    let root = tmp("ramulus-srv-");
    let first = repo(&root, "first");
    git(&first, &["init", "-q", s(&first.join("libs/inner"))]);
    let srv = Server::start(config(Some(&first), &first, &root.join("state")));
    let r = srv.result("findRepos", json!({}));
    assert_eq!(r["root"], s(&first));
    assert_eq!(r["inside"], true);
    assert_eq!(names(&r["repos"]), ["inner"]);
}

#[test]
fn keeps_preferences_across_runs() {
    let root = tmp("ramulus-srv-");
    let first = repo(&root, "first");
    let srv = Server::start(config(Some(&first), &first, &root.join("state")));
    assert_eq!(srv.result("prefs", json!({})), json!({}));
    srv.result("setPrefs", json!({ "prefs": { "theme": "light", "scheme": { "id": "x" } } }));
    assert_eq!(srv.result("prefs", json!({})), json!({ "theme": "light", "scheme": { "id": "x" } }));
    assert!(srv.error("setPrefs", json!({ "prefs": { "big": "x".repeat(30000) } })).contains("too large"));
}

#[test]
fn only_touches_repositories_the_user_opened() {
    let root = tmp("ramulus-srv-");
    let first = repo(&root, "first");
    let second = repo(&root, "second");
    let srv = Server::start(config(Some(&first), &first, &root.join("state")));
    assert_eq!(srv.call_as("status", json!({}), &"b".repeat(32))["error"], "bad token");
    assert_eq!(srv.result("status", json!({}))["unstaged"], json!([]));
    assert!(srv.error("status", json!({ "repo": second })).contains("Open that repository first"));
    assert!(srv.error("openRepo", json!({ "path": root.join("missing") })).contains("does not exist"));
    assert_eq!(srv.result("openRepo", json!({ "path": second.join(".") }))["name"], "second");
    assert_eq!(srv.result("status", json!({ "repo": second }))["unstaged"], json!([]));
    let repos = srv.result("repos", json!({}));
    assert_eq!(repos["current"]["dir"], s(&first));
    assert_eq!(names(&repos["recent"]), ["second", "first"]);
    assert_eq!(srv.call("constructor", json!({}))["error"], "unknown operation");
    srv.result("setPins", json!({ "dirs": [second, root.join("gone"), 42] }));
    assert_eq!(names(&srv.result("pins", json!({}))), ["second"]);
    let events = |repo: &Path| srv.get(&format!("/api/events?token={TOKEN}&repo={}", urlencode(s(repo)))).status().as_u16();
    assert_eq!(events(&root.join("other")), 401);
    assert_eq!(events(&second), 200);
    assert_eq!(srv.get("/index.html").status().as_u16(), 404);
    assert_eq!(srv.get("/../Cargo.toml").status().as_u16(), 404);
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[test]
fn saves_a_large_edit_and_reports_changes_as_they_happen() {
    let root = tmp("ramulus-srv-");
    let first = repo(&root, "first");
    let srv = Server::start(config(Some(&first), &first, &root.join("state")));
    let mut events = srv.stream(&format!("/api/events?token={TOKEN}"));
    events.until(": connected");
    let big = "x".repeat(1_500_000);
    srv.result("writeWorkdir", json!({ "path": "big.txt", "content": big, "expected": "" }));
    assert_eq!(read(&first, "big.txt").len(), 1_500_000);
    events.until("data: changed");
    let v = srv.result("fileVersions", json!({ "area": { "kind": "unstaged" }, "path": "big.txt" }));
    assert_eq!(v["new"].as_str().unwrap().len(), 1_500_000);
}

#[test]
fn refuses_other_hosts() {
    let root = tmp("ramulus-srv-");
    let first = repo(&root, "first");
    let srv = Server::start(config(Some(&first), &first, &root.join("state")));
    let agent = ureq::Agent::new_with_config(ureq::Agent::config_builder().http_status_as_error(false).build());
    let res = agent
        .post(&format!("{}/api/status", srv.base))
        .header("host", "evil.example")
        .header("x-ramulus-token", TOKEN)
        .send_json(json!({}))
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
}

fn ai_server() -> (std::path::PathBuf, std::path::PathBuf, Server) {
    let root = tmp("ramulus-ai-test-");
    let bin = root.join("bin");
    stub_agent(&bin);
    let repo = repo(&root, "repo");
    git(&repo, &["config", "core.autocrlf", "false"]);
    let mut cfg = config(Some(&repo), &repo, &root.join("state"));
    cfg.env = env_with_path(&bin);
    (root, repo, Server::start(cfg))
}

#[test]
fn asks_first_then_runs_the_chosen_agent_with_the_repository_context() {
    let (_root, repo, srv) = ai_server();
    let info = srv.result("ai", json!({}));
    assert!(info["agents"].as_array().unwrap().iter().any(|a| a["id"] == "claude"));
    assert_eq!(info["settings"], json!({ "prompts": {} }));
    assert!(srv.error("aiAsk", json!({ "agent": "claude", "prompt": "hi" })).contains("turned off"));
    srv.result("setAi", json!({ "settings": { "enabled": true, "agent": "claude", "prompts": { "commit": "Be brief" } } }));
    assert_eq!(
        srv.result("ai", json!({}))["settings"],
        json!({ "enabled": true, "agent": "claude", "prompts": { "commit": "Be brief" } })
    );
    write(&repo, "notes.txt", "hello\n");
    git(&repo, &["add", "."]);
    let ctx = srv.result("aiContext", json!({ "task": "commit" }));
    let ctx = ctx.as_str().unwrap();
    assert!(ctx.contains("notes.txt") && ctx.contains("+hello"), "{ctx}");
    assert_eq!(srv.result("aiAsk", json!({ "agent": "claude", "prompt": "Add notes" })), "Add notes");
}

#[test]
fn runs_the_agent_in_a_terminal_and_streams_what_it_prints() {
    let (_root, repo, srv) = ai_server();
    srv.result("setAi", json!({ "settings": { "enabled": true } }));
    assert_eq!(srv.result("termStart", json!({ "agent": "claude", "cols": 80, "rows": 24 }))["fresh"], true);
    let mut stream = srv.term(s(&repo), "main");
    stream.input("hello ramulus\r");
    stream.until("hello ramulus");
    assert_eq!(srv.result("termStart", json!({ "agent": "claude", "cols": 100, "rows": 30 }))["fresh"], false);
    srv.result("termStop", json!({}));
    stream.until(r#""exit":"#);
}

#[test]
fn keeps_each_terminal_tab_separate_and_stops_them_one_at_a_time() {
    let (_root, repo, srv) = ai_server();
    srv.result("setAi", json!({ "settings": { "enabled": true } }));
    let stream = |id: &str| srv.term(s(&repo), id);
    assert_eq!(srv.result("termStart", json!({ "id": "one", "agent": "claude", "cols": 80, "rows": 24 }))["fresh"], true);
    assert_eq!(srv.result("termStart", json!({ "id": "two", "agent": "claude", "cols": 80, "rows": 24 }))["fresh"], true);
    // Windows' cmd.exe names its window as it starts, so the titles can be there already
    let mut tabs = srv.result("termList", json!({}));
    tabs.as_array_mut().unwrap().iter_mut().for_each(|t| drop(t.as_object_mut().unwrap().remove("title")));
    assert_eq!(
        tabs,
        json!([{ "id": "one", "kind": "agent", "agent": "claude" }, { "id": "two", "kind": "agent", "agent": "claude" }])
    );
    let mut one = stream("one");
    let mut two = stream("two");
    two.input("only in two\r");
    two.until("only in two");
    one.input("only in one\r");
    one.until("only in one");
    assert!(!one.seen.contains("only in two"));
    srv.result("termStop", json!({ "id": "one" }));
    one.until(r#""exit":"#);
    two.input("still here\r");
    two.until("still here");
    assert!(srv.error("termStart", json!({ "id": "Bad Id", "agent": "claude" })).contains("Invalid terminal id"));
    srv.result("termStop", json!({ "all": true }));
    two.until(r#""exit":"#);
}

#[cfg(unix)]
#[test]
fn opens_a_plain_shell_tab_without_the_ai_setting() {
    let (_root, repo, srv) = ai_server();
    srv.result("setAi", json!({ "settings": { "enabled": false, "prompts": {} } }));
    assert!(srv.error("termStart", json!({ "id": "agent", "agent": "claude" })).contains("turned off"));
    assert!(srv.result("termStart", json!({ "id": "sh", "kind": "shell", "cols": 80, "rows": 24 }))["agent"].is_null());
    let mut sh = srv.term(s(&repo), "sh");
    sh.resize(100, 30);
    sh.input("stty size\r");
    sh.until("30 100");
    srv.result("termStop", json!({ "id": "sh" }));
}

#[test]
fn refuses_a_terminal_socket_without_the_token_or_for_a_folder_not_opened() {
    let (root, _repo, srv) = ai_server();
    let bad = tungstenite::connect(format!("{}/api/term?token=nope", srv.base.replacen("http", "ws", 1)));
    assert!(matches!(bad, Err(tungstenite::Error::Http(r)) if r.status() == 401));
    srv.term(s(&root.join("other")), "main").until(r#"{"ch":1,"exit":null}"#);
}

#[test]
fn replays_what_a_terminal_printed_before_the_tab_attached() {
    let (_root, repo, srv) = ai_server();
    srv.result("setAi", json!({ "settings": { "enabled": true } }));
    srv.result("termStart", json!({ "id": "late", "agent": "claude", "cols": 80, "rows": 24 }));
    let mut typing = srv.term(s(&repo), "late");
    typing.input("typed before attach\r");
    typing.until("typed before attach");
    let mut stream = srv.term(s(&repo), "late");
    stream.until("typed before attach");
    assert!(stream.seen.starts_with(r#"{"ch":1,"replay":"#), "{}", stream.seen);
    srv.result("termStop", json!({ "id": "late" }));
    stream.until(r#""exit":"#);
    let mut gone = srv.term(s(&repo), "late");
    gone.until(r#"{"ch":1,"exit":null}"#);
}

#[test]
fn opens_a_folder_without_git_and_starts_a_repository_in_it() {
    let root = tmp("ramulus-srv-");
    let plain = root.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let srv = Server::start(config(None, &root, &root.join("state")));
    let opened = srv.result("openRepo", json!({ "path": s(&plain) }));
    assert_eq!(opened["name"], "plain");
    let dir = opened["dir"].as_str().unwrap().to_string();
    assert!(srv.error("load", json!({ "repo": dir })).contains("not a git repository"));
    srv.result("init", json!({ "repo": dir }));
    assert_eq!(srv.result("status", json!({ "repo": dir }))["unstaged"], json!([]));
}
