// Its own test binary: stopping the helper ends every AI draft in the process, which would cut into other tests.
#![cfg(unix)]
mod common;
use common::*;
use serde_json::json;

fn repo(root: &std::path::Path, name: &str) -> std::path::PathBuf {
    let d = root.join(name);
    git(root, &["init", "-q", "-b", "main", s(&d)]);
    toplevel(&d)
}

#[test]
fn brings_terminal_tabs_back_after_the_helper_restarts() {
    let root = tmp("ramulus-ai-test-");
    let bin = root.join("bin");
    stub_agent(&bin);
    let repo = repo(&root, "repo");
    let claude_home = root.join("claude");
    let start = || {
        let mut cfg = config(Some(&repo), &repo, &root.join("state"));
        cfg.env = env_with_path(&bin);
        for (k, v) in [
            ("SHELL", "/bin/sh"),
            ("SHOWARGS", "1"),
            ("TITLE", "\u{2733} Fix the login"),
            ("CLAUDE_CONFIG_DIR", s(&claude_home)),
        ] {
            cfg.env.insert(k.into(), v.into());
        }
        Server::start(cfg)
    };
    let srv = start();
    srv.result("setAi", json!({ "settings": { "enabled": true } }));
    srv.result("termStart", json!({ "id": "sh", "kind": "shell", "cols": 80, "rows": 24 }));
    let mut sh = srv.term(s(&repo), "sh");
    sh.input("echo kept-$((40+2))\r");
    sh.until("kept-42");
    // a second helper beside this one leaves its saved tabs alone
    assert_eq!(start().result("termList", json!({})), json!([]));
    srv.result("termStart", json!({ "id": "ai", "agent": "claude", "cols": 80, "rows": 24 }));
    let mut ai = srv.term(s(&repo), "ai");
    ai.until("args:--session-id ");
    let at = ai.seen.find("args:--session-id ").unwrap() + 18;
    ai.until("\\r\\n");
    let uuid = ai.seen[at..at + 36].to_string();
    let titled = json!([{ "id": "sh", "kind": "shell" }, { "id": "ai", "kind": "agent", "agent": "claude", "title": "\u{2733} Fix the login" }]);
    for _ in 0..50 {
        if srv.result("termList", json!({})) == titled {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert_eq!(srv.result("termList", json!({})), titled);
    // a drag in the page reorders the tabs, and they come back in that order
    srv.result("termOrder", json!({ "ids": ["ai", "sh", "gone"] }));
    let ordered = json!([titled[1], titled[0]]);
    assert_eq!(srv.result("termList", json!({})), ordered);
    srv.app.stop_agents();

    // Claude Code saved the conversation, so the tab resumes it rather than starting a new one
    std::fs::create_dir_all(claude_home.join("projects/x")).unwrap();
    std::fs::write(claude_home.join(format!("projects/x/{uuid}.jsonl")), "{}").unwrap();
    let again = start();
    assert_eq!(again.result("termList", json!({})), ordered);
    assert_eq!(again.result("termStart", json!({ "id": "sh", "kind": "shell", "cols": 80, "rows": 24 }))["fresh"], true);
    let mut sh = again.term(s(&repo), "sh");
    sh.until("kept-42");
    sh.until("new session");
    again.result("termStart", json!({ "id": "ai", "agent": "claude", "cols": 80, "rows": 24 }));
    again.term(s(&repo), "ai").until(&format!("args:--resume {uuid}"));
    again.result("termStop", json!({ "id": "sh" }));
    again.app.stop_agents();

    let third = start();
    assert_eq!(third.result("termList", json!({})), json!([titled[1]]));
    third.app.stop_agents();
}
