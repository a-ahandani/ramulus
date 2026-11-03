mod common;
use common::*;
use ramulus::ai;
use ramulus::term::trim_tail;
use serde_json::json;
use std::time::{Duration, Instant};

const MINUTES_5: Duration = Duration::from_secs(300);

// kill_all reaches every draft in the process, so the tests that run an agent take turns
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn turn() -> std::sync::MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner())
}

fn setup() -> (std::path::PathBuf, ramulus::Env) {
    let root = tmp("ramulus-ai-test-");
    let bin = root.join("bin");
    stub_agent(&bin);
    (root, env_with_path(&bin))
}

#[test]
fn finds_installed_agents_on_the_path() {
    let (root, mut env) = setup();
    env.insert("PATH".into(), root.join("bin").to_string_lossy().into_owned());
    assert_eq!(ai::detect(&env), vec![json!({ "id": "claude", "name": "Claude Code" })]);
    env.insert("PATH".into(), root.join("none").to_string_lossy().into_owned());
    assert!(ai::detect(&env).is_empty());
}

#[tokio::test]
async fn sends_the_prompt_on_stdin_and_returns_the_reply() {
    let _turn = turn();
    let (_root, env) = setup();
    assert_eq!(ai::ask("claude", "feat/login-form", &env, MINUTES_5).await.unwrap(), "feat/login-form");
    assert!(ai::ask("nope", "x", &env, MINUTES_5).await.unwrap_err().0.contains("not installed"));
}

#[tokio::test]
async fn runs_drafts_outside_the_repository() {
    let _turn = turn();
    let (root, mut env) = setup();
    env.insert("SHOWDIR".into(), "1".into());
    let where_ = ai::ask("claude", "x", &env, MINUTES_5).await.unwrap();
    assert!(!where_.contains(root.to_str().unwrap()), "{where_}");
}

#[tokio::test]
async fn stops_every_running_draft_when_the_helper_quits_and_gives_up_after_the_timeout() {
    let _turn = turn();
    let (_root, mut env) = setup();
    env.insert("SLOW".into(), "1".into());
    let started = Instant::now();
    let slow = env.clone();
    let pending = tokio::spawn(async move { ai::ask("claude", "x", &slow, MINUTES_5).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    ai::kill_all();
    assert!(pending.await.unwrap().is_err());
    assert!(started.elapsed() < Duration::from_secs(5));
    // kill_all reaches every draft in the process, so the timeout check runs after it rather than beside it
    let e = ai::ask("claude", "x", &env, Duration::from_millis(500)).await.unwrap_err().0;
    assert!(e.contains("did not answer within"), "{e}");
}

#[test]
fn keeps_a_bounded_replay_buffer_even_without_newlines() {
    assert_eq!(trim_tail(&"x".repeat(300), 100).len(), 100);
    assert_eq!(trim_tail(&format!("{}\n{}", "a".repeat(50), "b".repeat(80)), 100), "b".repeat(80));
    assert_eq!(trim_tail("short", 100), "short");
}

#[tokio::test]
async fn reports_the_agents_own_error() {
    let _turn = turn();
    let (_root, mut env) = setup();
    env.insert("FAIL".into(), "1".into());
    assert!(ai::ask("claude", "x", &env, MINUTES_5).await.unwrap_err().0.contains("Claude Code: not signed in"));
}

#[tokio::test]
async fn stops_a_running_agent_at_once_when_the_request_is_dropped() {
    let _turn = turn();
    let (_root, mut env) = setup();
    env.insert("SLOW".into(), "1".into());
    let started = Instant::now();
    tokio::select! {
        r = ai::ask("claude", "x", &env, MINUTES_5) => panic!("finished: {r:?}"),
        _ = tokio::time::sleep(Duration::from_millis(300)) => {}
    }
    assert!(ai::ask("claude", "quick", &env.into_iter().filter(|(k, _)| k != "SLOW").collect(), MINUTES_5).await.is_ok());
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn keeps_only_known_settings() {
    let cleaned = ai::clean_settings(&json!({ "enabled": "yes", "agent": "other", "prompts": { "commit": "Short please", "branch": "  ", "evil": "x" } }));
    assert_eq!(cleaned, json!({ "prompts": { "commit": "Short please" } }));
}
