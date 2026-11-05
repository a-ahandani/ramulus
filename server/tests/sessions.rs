// Its own test binary: stopping the helper ends every agent in the process, which would cut into other tests.
#![cfg(unix)]
mod common;
use common::*;
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const C1: &str = "11111111-1111-4111-8111-111111111111";
const C2: &str = "22222222-2222-4222-8222-222222222222";
const X1: &str = "019f0000-0000-7000-8000-000000000001";
const X2: &str = "019f0000-0000-7000-8000-000000000002";

fn file(path: &Path, lines: &[Value], at: SystemTime) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(path, text).unwrap();
    std::fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
}

fn secs(n: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(n)
}

fn stub(bin: &Path, name: &str, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(bin.join(name), format!("#!/bin/sh\n{script}")).unwrap();
    std::fs::set_permissions(bin.join(name), std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn lists_and_resumes_the_conversations_held_in_a_folder() {
    let root = tmp("ramulus-sessions-");
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let dir = root.join("my.repo");
    git(&root, &["init", "-q", "-b", "main", s(&dir)]);
    let repo = toplevel(&dir);
    let r = s(&repo);
    stub(&bin, "claude", "echo \"args:$*\"\ncat\n");
    stub(&bin, "codex", "echo \"args:$*\"\ncat\n");
    let listed = json!([
        { "id": "ses_abc", "title": "Tidy the docs", "updated": 5_000_000, "created": 4_000_000, "directory": r },
        { "id": "ses_other", "title": "Elsewhere", "updated": 6_000_000, "created": 1, "directory": s(&root.join("other")) },
    ]);
    stub(
        &bin,
        "opencode",
        &format!("if [ \"$1\" = session ]; then echo '{listed}'; exit 0; fi\necho \"args:$*\"\ncat\n"),
    );

    let claude = root.join("claude");
    let projects = claude.join("projects").join(r.replace(|c: char| !c.is_ascii_alphanumeric(), "-"));
    let user = |content: Value| json!({ "type": "user", "cwd": r, "message": { "role": "user", "content": content } });
    let reply = |usage: Value, side: bool| json!({ "type": "assistant", "isSidechain": side, "message": { "role": "assistant", "usage": usage } });
    file(
        &projects.join(format!("{C1}.jsonl")),
        &[
            json!({ "type": "mode" }),
            user(json!("fix the\nlogin")),
            json!({ "type": "ai-title", "aiTitle": "Old name" }),
            reply(json!({ "input_tokens": 9, "cache_read_input_tokens": 9 }), false),
            json!({ "type": "cost-state", "totalCostUSD": 0.5 }),
            reply(
                json!({ "input_tokens": 2, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 162000, "output_tokens": 500 }),
                false,
            ),
            // a subagent's request is not what the conversation carries
            reply(json!({ "input_tokens": 7 }), true),
            json!({ "type": "cost-state", "totalCostUSD": 19.41 }),
            json!({ "type": "ai-title", "aiTitle": "Login fix" }),
        ],
        secs(9000),
    );
    file(
        &projects.join(format!("{C2}.jsonl")),
        &[
            user(json!("<command-name>/login</command-name>")),
            user(json!([{ "type": "text", "text": "add  tests\tplease" }])),
        ],
        secs(8000),
    );
    // another folder whose name turns into the same directory name, a conversation with nothing asked, and one running elsewhere
    let mut elsewhere = user(json!("elsewhere"));
    elsewhere["cwd"] = json!(s(&root.join("my-repo")));
    file(&projects.join("33333333-3333-4333-8333-333333333333.jsonl"), &[elsewhere], secs(9500));
    let mut meta = user(json!("ignored"));
    meta["isMeta"] = json!(true);
    file(
        &projects.join("44444444-4444-4444-8444-444444444444.jsonl"),
        &[user(json!("<command-name>/login</command-name>")), meta],
        secs(9600),
    );
    file(&projects.join("55555555-5555-4555-8555-555555555555.jsonl"), &[user(json!("still going"))], secs(9700));
    std::fs::create_dir_all(claude.join("sessions")).unwrap();
    write(
        &claude.join("sessions"),
        &format!("{}.json", std::process::id()),
        &json!({ "pid": std::process::id(), "sessionId": "55555555-5555-4555-8555-555555555555" }).to_string(),
    );
    write(&claude.join("sessions"), "999999.json", &json!({ "pid": 999999, "sessionId": C1 }).to_string());

    let day = root.join("codex/sessions/2026/11/05");
    let meta = |id: &str, source: Value| json!({ "type": "session_meta", "payload": { "id": id, "cwd": r, "source": source, "timestamp": "2026-11-05T10:00:00Z" } });
    let asked = |m: &str| json!({ "type": "event_msg", "payload": { "type": "user_message", "message": m } });
    let counted = |input: u64, total: u64| json!({ "type": "event_msg", "payload": { "type": "token_count", "info": { "total_token_usage": { "total_tokens": total }, "last_token_usage": { "input_tokens": input }, "model_context_window": 258400 } } });
    file(
        &day.join(format!("rollout-a-{X1}.jsonl")),
        &[
            meta(X1, json!("cli")),
            asked("# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n## My request for Codex:\nRename the button"),
            counted(5000, 6000),
            counted(117032, 2809339),
            json!({ "type": "event_msg", "payload": { "type": "token_count", "info": null } }),
        ],
        secs(7000),
    );
    file(&day.join(format!("rollout-b-{X2}.jsonl")), &[meta(X2, json!("vscode")), asked("first try")], secs(6000));
    file(&day.join("rollout-c-x3.jsonl"), &[meta("x3", json!("exec")), asked("a script ran this")], secs(9900));
    file(
        &day.join("rollout-d-x4.jsonl"),
        &[meta("x4", json!({ "subagent": "review" })), asked("a helper ran this")],
        secs(9900),
    );
    write(
        &root.join("codex"),
        "session_index.jsonl",
        &format!("{}\n{}\n", json!({ "id": X2, "thread_name": "Old" }), json!({ "id": X2, "thread_name": "Named thread" })),
    );

    let mut cfg = config(Some(&repo), &repo, &root.join("state"));
    cfg.env = env_with_path(&bin);
    for (k, v) in [("CLAUDE_CONFIG_DIR", s(&claude).to_string()), ("CODEX_HOME", s(&root.join("codex")).to_string())] {
        cfg.env.insert(k.into(), v);
    }
    let srv = Server::start(cfg);
    srv.result("setAi", json!({ "settings": { "enabled": true } }));
    assert_eq!(
        srv.result("agentSessions", json!({})),
        json!([
            { "agent": "claude", "id": C1, "title": "Login fix", "time": 9_000_000, "context": 163002, "cost": 19.41 },
            { "agent": "claude", "id": C2, "title": "add tests please", "time": 8_000_000 },
            { "agent": "codex", "id": X1, "title": "Rename the button", "time": 7_000_000, "context": 117032, "window": 258400, "tokens": 2809339 },
            { "agent": "codex", "id": X2, "title": "Named thread", "time": 6_000_000 },
            { "agent": "opencode", "id": "ses_abc", "title": "Tidy the docs", "time": 5_000_000 },
        ])
    );

    for (id, agent, resume, args) in [
        ("a", "claude", C2, format!("args:--resume {C2}")),
        ("b", "codex", X1, format!("args:resume {X1}")),
        ("c", "opencode", "ses_abc", "args:--session ses_abc".into()),
    ] {
        srv.result("termStart", json!({ "id": id, "agent": agent, "resume": resume, "cols": 80, "rows": 24 }));
        srv.term_stream(r, id).until(&args);
    }
    let ids = |v: Value| v.as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(ids(srv.result("agentSessions", json!({}))), [C1, X2]);
    // a new Codex tab's own conversation is whatever Codex changes after it started
    srv.result("termStart", json!({ "id": "d", "agent": "codex", "cols": 80, "rows": 24 }));
    std::fs::File::options()
        .write(true)
        .open(day.join(format!("rollout-b-{X2}.jsonl")))
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(5))
        .unwrap();
    assert_eq!(ids(srv.result("agentSessions", json!({}))), [C1]);
    assert!(srv
        .error("termStart", json!({ "id": "e", "agent": "codex", "resume": "a&calc", "cols": 80, "rows": 24 }))
        .contains("cannot be resumed"));
    assert!(srv
        .error("termStart", json!({ "id": "e", "agent": "claude", "resume": "not-a-uuid", "cols": 80, "rows": 24 }))
        .contains("cannot be resumed"));
    srv.app.stop_agents();
}

#[test]
fn an_agent_at_work_keeps_the_computer_awake() {
    use ramulus::term::{claude_busy, Terminals, QUIET};
    let busy: Vec<bool> = [Some("◐ Fix the login"), Some("✳ Fix the login"), Some("Claude Code"), Some("✳"), None]
        .into_iter()
        .map(claude_busy)
        .collect();
    assert_eq!(busy, [true, false, false, false, false]);

    let root = tmp("ramulus-wake-");
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    stub(&bin, "codex", "echo working\ncat\n");
    let terms = Terminals::new(None);
    let env = env_with_path(&bin);
    assert!(!terms.working(QUIET));
    terms.start(s(&root), "w", "agent", "codex", Some(80), Some(24), None, &env).unwrap();
    for _ in 0..50 {
        if terms.working(QUIET) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // it just printed, so it counts as working until it has been quiet for a while
    assert!(terms.working(QUIET));
    assert!(!terms.working(Duration::ZERO));
    terms.stop_all();
}
