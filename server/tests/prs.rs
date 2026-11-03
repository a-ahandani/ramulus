#![cfg(unix)]
mod common;
use common::*;
use ramulus::prs::{change_pull_request, merge_pull_request, pr_conversation, pull_request, pull_requests};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const LIST: &str = r#"[{"number":7,"title":"Add login","url":"https://github.com/o/r/pull/7","headRefName":"login","state":"OPEN","isDraft":true},{"number":3,"title":"Old","url":"https://github.com/o/r/pull/3","headRefName":"old","state":"MERGED","isDraft":false}]"#;

struct Stub {
    root: PathBuf,
    bin: PathBuf,
}

impl Stub {
    fn new() -> Stub {
        let root = tmp("ramulus-prs-");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let r = root.display();
        let script = format!(
            "#!/bin/sh\nif [ -n \"$GITHUB_TOKEN\" ]; then echo 'HTTP 401: Bad credentials' >&2; exit 1; fi\nif [ \"$1\" = api ]; then printf '%s\\n' \"$@\" >> \"{r}/api.log\"; /bin/cat \"{r}/talk.json\"; exit 0; fi\nif [ \"$2\" = view ]; then /bin/cat \"{r}/view.json\"; exit 0; fi\nif [ \"$2\" = ready ] || [ \"$2\" = close ] || [ \"$2\" = reopen ]; then echo \"$@\" >> \"{r}/changes.log\"; exit 0; fi\nif [ \"$2\" = merge ]; then echo \"$@\" >> \"{r}/merges.log\"; if [ \"$3\" = 9 ]; then echo 'Pull request is not mergeable: the merge commit cannot be cleanly created.' >&2; exit 1; fi; exit 0; fi\necho '{LIST}'\n"
        );
        std::fs::write(bin.join("gh"), script).unwrap();
        std::fs::set_permissions(bin.join("gh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        Stub { root, bin }
    }
    fn env(&self, token: bool) -> ramulus::Env {
        let mut e = ramulus::Env::new();
        e.insert("PATH".into(), self.bin.to_string_lossy().into_owned());
        if token {
            e.insert("GITHUB_TOKEN".into(), "stale".into());
        }
        e
    }
    fn repo(&self, name: &str) -> String {
        let d = self.root.join(name);
        std::fs::create_dir_all(&d).unwrap();
        s(&d).to_string()
    }
    fn log(&self, name: &str) -> String {
        std::fs::read_to_string(self.root.join(name)).unwrap_or_default()
    }
    fn view(&self) -> Value {
        json!({
            "number": 7, "title": "Add login", "body": "Adds **login**", "state": "OPEN", "isDraft": false, "author": { "login": "maya" }, "headRefName": "login", "baseRefName": "main",
            "url": "https://github.com/o/r/pull/7", "createdAt": "2026-10-01T00:00:00Z", "reviewDecision": "APPROVED", "mergeStateStatus": "CLEAN", "additions": 12, "deletions": 3,
            "statusCheckRollup": [
                { "__typename": "CheckRun", "name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://ci/1" },
                { "__typename": "CheckRun", "name": "lint", "workflowName": "CI", "status": "IN_PROGRESS", "conclusion": "", "detailsUrl": "https://ci/2" },
                { "__typename": "CheckRun", "name": "e2e", "workflowName": "CI", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://ci/3" },
                { "__typename": "StatusContext", "context": "deploy", "state": "PENDING", "targetUrl": "https://deploy" },
            ],
        })
    }
    fn put(&self, name: &str, v: &Value) {
        std::fs::write(self.root.join(name), v.to_string()).unwrap();
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn reads_them_through_gh_retrying_without_a_token_that_gh_rejects() {
    let st = Stub::new();
    let list = pull_requests(&st.repo("a"), &st.env(true)).await;
    assert_eq!(
        list,
        vec![
            json!({ "number": 7, "title": "Add login", "url": "https://github.com/o/r/pull/7", "branch": "login", "state": "DRAFT" }),
            json!({ "number": 3, "title": "Old", "url": "https://github.com/o/r/pull/3", "branch": "old", "state": "MERGED" }),
        ]
    );
}

#[tokio::test]
async fn merges_through_gh_with_the_chosen_method_and_passes_refusals_on() {
    let st = Stub::new();
    let dir = st.repo("c");
    let env = st.env(true);
    merge_pull_request(&dir, 7, "squash", &env).await.unwrap();
    assert_eq!(st.log("merges.log"), "pr merge 7 --squash\n");
    assert!(merge_pull_request(&dir, 9, "merge", &env).await.unwrap_err().0.contains("not mergeable"));
    assert!(merge_pull_request(&dir, 7, "fast", &env).await.unwrap_err().0.contains("Invalid merge method"));
    assert!(merge_pull_request(&dir, 0, "merge", &env).await.unwrap_err().0.contains("Invalid pull request number"));
}

#[tokio::test]
async fn reads_one_pull_request_with_its_checks() {
    let st = Stub::new();
    st.put("view.json", &st.view());
    let pr = pull_request(&st.repo("d"), 7, &st.env(false)).await.unwrap();
    assert_eq!(pr["author"], "maya");
    let checks: Vec<String> = pr["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| format!("{}:{}", c["name"].as_str().unwrap(), c["state"].as_str().unwrap()))
        .collect();
    assert_eq!(checks, ["test:pass", "lint:running", "e2e:fail", "deploy:running"]);
    assert_eq!(pr["checks"][3]["url"], "https://deploy");
    assert!(pull_request(&st.repo("e"), 0, &st.env(false)).await.unwrap_err().0.contains("Invalid pull request number"));
}

#[tokio::test]
async fn reads_the_conversation_from_the_pull_request_host() {
    let st = Stub::new();
    st.put("view.json", &st.view());
    let person = |login: &str, kind: &str| json!({ "__typename": kind, "login": login, "avatarUrl": format!("https://avatars.githubusercontent.com/{login}") });
    let n = |id: &str, login: &str, extra: Value| {
        let mut v = json!({ "id": id, "body": format!("text {id}"), "bodyHTML": format!("<p>{id}</p>"), "url": format!("https://github.com/o/r/pull/7#{id}"), "author": person(login, "User") });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    };
    let mut c2 = n("c2", "ci", json!({ "createdAt": "2026-10-04T00:00:00Z" }));
    c2["author"] = person("ci", "Bot");
    let mut c3 = n("c3", "x", json!({ "createdAt": "2026-10-05T00:00:00Z" }));
    c3["author"] = Value::Null;
    st.put(
        "talk.json",
        &json!({ "data": { "repository": { "pullRequest": {
            "body": "desc", "bodyHTML": "<p>desc</p>", "author": { "avatarUrl": "https://avatars.githubusercontent.com/maya" },
            "comments": { "nodes": [n("c1", "sam", json!({ "createdAt": "2026-10-03T00:00:00Z" })), c2, c3] },
            "reviews": { "nodes": [
                n("r1", "leo", json!({ "state": "APPROVED", "body": "", "submittedAt": "2026-10-02T00:00:00Z" })),
                n("r2", "leo", json!({ "state": "COMMENTED", "body": "", "submittedAt": "2026-10-02T00:00:00Z" })),
                n("r3", "leo", json!({ "state": "COMMENTED", "body": "Overall good", "submittedAt": "2026-10-02T00:00:00Z" })),
                n("r4", "me", json!({ "state": "PENDING", "body": "draft", "submittedAt": null })),
            ] },
            "reviewThreads": { "nodes": [
                { "id": "t1", "path": "src/a.ts", "line": null, "startLine": null, "originalLine": 9, "originalStartLine": 7, "isResolved": true, "isOutdated": true,
                  "comments": { "nodes": [n("n1", "leo", json!({ "createdAt": "2026-10-02T00:00:00Z", "diffHunk": "@@ -1 +1 @@\n+a" })), n("n2", "maya", json!({ "createdAt": "2026-10-03T00:00:00Z" }))] } },
                { "id": "t2", "path": "src/b.ts", "line": 3, "startLine": null, "isResolved": false, "isOutdated": false, "comments": { "nodes": [] } },
            ] },
        } } } }),
    );
    let talk = pr_conversation(&st.repo("h"), 7, &st.env(false)).await.unwrap();
    assert_eq!(talk["text"], "desc");
    assert_eq!(talk["html"], "<p>desc</p>");
    let who: Vec<(String, bool)> = talk["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["author"].as_str().unwrap().into(), c["bot"].as_bool().unwrap()))
        .collect();
    assert_eq!(who, [("sam".to_string(), false), ("ci".into(), true), ("unknown".into(), false)]);
    assert_eq!(
        talk["reviews"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(),
        ["r1", "r3"]
    );
    assert_eq!(talk["reviews"][0]["at"], "2026-10-02T00:00:00Z");
    assert_eq!(talk["threads"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect::<Vec<_>>(), ["t1"]);
    assert_eq!((talk["threads"][0]["line"].as_i64(), talk["threads"][0]["startLine"].as_i64()), (Some(9), Some(7)));
    assert_eq!(talk["threads"][0]["hunk"], "@@ -1 +1 @@\n+a");
    assert_eq!(talk["threads"][0]["notes"].as_array().unwrap().len(), 2);
    let args: Vec<String> = st.log("api.log").lines().map(String::from).collect();
    for a in ["github.com", "owner=o", "name=r", "number=7"] {
        assert!(args.iter().any(|x| x == a), "{a} missing from {args:?}");
    }
    assert!(pr_conversation(&st.repo("i"), 0, &st.env(false))
        .await
        .unwrap_err()
        .0
        .contains("Invalid pull request number"));
}

#[tokio::test]
async fn keeps_a_view_for_a_moment_and_forgets_it_after_a_change() {
    let st = Stub::new();
    st.put("view.json", &st.view());
    let dir = st.repo("g");
    let first = pull_request(&dir, 7, &st.env(false)).await.unwrap();
    let mut renamed = st.view();
    renamed["title"] = json!("Renamed");
    st.put("view.json", &renamed);
    assert_eq!(pull_request(&dir, 7, &st.env(false)).await.unwrap()["title"], first["title"]);
    change_pull_request(&dir, 7, "draft", &st.env(false)).await.unwrap();
    assert_eq!(pull_request(&dir, 7, &st.env(false)).await.unwrap()["title"], "Renamed");
}

#[tokio::test]
async fn marks_as_draft_or_ready_closes_and_reopens_through_gh() {
    let st = Stub::new();
    let dir = st.repo("f");
    for action in ["draft", "ready", "close", "reopen"] {
        change_pull_request(&dir, 7, action, &st.env(false)).await.unwrap();
    }
    assert!(st.log("changes.log").ends_with("pr ready 7 --undo\npr ready 7\npr close 7\npr reopen 7\n"));
    assert!(change_pull_request(&dir, 7, "constructor", &st.env(false))
        .await
        .unwrap_err()
        .0
        .contains("Invalid pull request action"));
}

#[tokio::test]
async fn returns_nothing_when_gh_is_missing() {
    let st = Stub::new();
    let mut env = ramulus::Env::new();
    env.insert("PATH".into(), Path::new(&st.root).join("none").to_string_lossy().into_owned());
    assert!(pull_requests(&st.repo("b"), &env).await.is_empty());
}
