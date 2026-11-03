mod common;
use common::*;
use ramulus::git::{self, DiffArea, FileChange, FileVersions, PushResult, RemoteSwitch};
use std::path::Path;

fn ch(path: &str, kind: char, stats: Option<(u64, u64)>) -> FileChange {
    FileChange {
        path: path.into(),
        kind,
        conflict: None,
        added: stats.map(|s| s.0),
        deleted: stats.map(|s| s.1),
    }
}

fn versions(old: &str, new: &str) -> FileVersions {
    FileVersions {
        old: old.into(),
        new: new.into(),
        binary: false,
    }
}

/// The helper commits, stashes and rebases as the repository's own user, so each test repository names one.
fn identity(dir: &Path) {
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "t@example.com"]);
}

fn init(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "core.autocrlf", "false"]);
    identity(dir);
}

#[tokio::test]
async fn stages_commits_tags_stashes_loads_and_edits() {
    let dir = tmp("ramulus-cli-");
    let d = s(&dir);
    init(&dir);
    write(&dir, "a.txt", "hello\n");
    assert_eq!(git::status(d).await.unwrap().unstaged, vec![ch("a.txt", '?', None)]);
    git::stage(d, &["a.txt".into()]).await.unwrap();
    assert_eq!(git::status(d).await.unwrap().staged, vec![ch("a.txt", 'A', Some((1, 0)))]);
    git::commit(d, "first", false).await.unwrap();
    write(&dir, "a.txt", "hello\nworld\n");
    git::stage(d, &["a.txt".into()]).await.unwrap();
    git::commit(d, "second\n\nmore detail", false).await.unwrap();
    let head = git(&dir, &["rev-parse", "HEAD"]).trim().to_string();
    git::create_tag(d, "v1", &head, Some("release one")).await.unwrap();
    write(&dir, "b.txt", "scratch\n");
    git::stash_save(d, Some("wip note")).await.unwrap();
    let data = git::load(d, 2000).await.unwrap();
    assert_eq!(data.head_branch.as_deref(), Some("main"));
    assert_eq!(data.head_oid.as_deref(), Some(head.as_str()));
    assert_eq!(
        data.commits.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(),
        ["On main: wip note", "second", "first"]
    );
    assert_eq!(data.commits[0].kind, "stash");
    assert_eq!(data.commits[0].parents.len(), 1);
    assert_eq!(data.commits[1].body, "more detail");
    assert_eq!((data.tags.len(), data.tags[0].name.as_str(), data.tags[0].oid.as_str()), (1, "v1", head.as_str()));
    let labels = &data.refs_by_oid[&head];
    assert!(labels.iter().any(|r| r.kind == "tag" && r.name == "v1"));
    assert!(labels.iter().any(|r| r.kind == "head" && r.current == Some(true)));
    assert_eq!(data.stashes.len(), 1);
    assert_eq!(git::commit_files(d, &head).await.unwrap(), vec![ch("a.txt", 'M', Some((1, 0)))]);
    let first = git(&dir, &["rev-parse", "HEAD~1"]).trim().to_string();
    assert_eq!(git::commit_files(d, &first).await.unwrap(), vec![ch("a.txt", 'A', Some((1, 0)))]);
    assert_eq!(
        git::file_versions(d, &DiffArea::Commit { oid: head.clone() }, "a.txt").await.unwrap(),
        versions("hello\n", "hello\nworld\n")
    );

    // refuses option-like names and discards only the named file
    assert!(git::create_branch(d, "--exec=true", "HEAD", false).await.unwrap_err().0.contains("Invalid name"));
    write(&dir, "a.txt", "changed\n");
    write(&dir, "c.txt", "new\n");
    git::discard(d, &[ch("a.txt", 'M', None)]).await.unwrap();
    assert_eq!(git::status(d).await.unwrap().unstaged, vec![ch("c.txt", '?', None)]);
    git::discard(d, &[ch("c.txt", '?', None)]).await.unwrap();
    assert!(git::status(d).await.unwrap().unstaged.is_empty());

    // reads file versions and writes exact index and working-tree contents
    write(&dir, "h.txt", "one\ntwo\nthree\n");
    git::stage(d, &["h.txt".into()]).await.unwrap();
    git::commit(d, "versions base", false).await.unwrap();
    write(&dir, "h.txt", "ONE\ntwo\nTHREE\n");
    let v = git::file_versions(d, &DiffArea::Unstaged, "h.txt").await.unwrap();
    assert_eq!(v, versions("one\ntwo\nthree\n", "ONE\ntwo\nTHREE\n"));
    assert!(git::write_index(d, "h.txt", "ONE\ntwo\nthree\n", Some("stale\n"))
        .await
        .unwrap_err()
        .0
        .contains("changed since"));
    git::write_index(d, "h.txt", "ONE\ntwo\nthree\n", Some(&v.old)).await.unwrap();
    assert_eq!(
        git::file_versions(d, &DiffArea::Staged, "h.txt").await.unwrap(),
        versions("one\ntwo\nthree\n", "ONE\ntwo\nthree\n")
    );
    let v = git::file_versions(d, &DiffArea::Unstaged, "h.txt").await.unwrap();
    assert_eq!(v, versions("ONE\ntwo\nthree\n", "ONE\ntwo\nTHREE\n"));
    assert!(git::write_workdir(d, "h.txt", "x", Some("stale\n")).await.unwrap_err().0.contains("changed since"));
    git::write_workdir(d, "h.txt", "ONE\ntwo\nthree\n", Some(&v.new)).await.unwrap();
    let st = git::status(d).await.unwrap();
    assert!(st.unstaged.is_empty());
    assert_eq!(st.staged, vec![ch("h.txt", 'M', Some((1, 1)))]);
    assert!(git::write_workdir(d, "../outside.txt", "x", None).await.unwrap_err().0.contains("outside"));
    assert_eq!(git::load(d, 2000).await.unwrap().local[0].ahead, Some(0));
    git::unstage(d, &["h.txt".into()]).await.unwrap();
    git::discard(d, &[ch("h.txt", 'M', None)]).await.unwrap();

    // counts lines for a file renamed inside a folder
    std::fs::create_dir_all(dir.join("src")).unwrap();
    write(&dir, "src/a.ts", "a\nb\n");
    git::stage(d, &["src/a.ts".into()]).await.unwrap();
    git::commit(d, "add a.ts", false).await.unwrap();
    git(&dir, &["mv", "src/a.ts", "src/b.ts"]);
    write(&dir, "src/b.ts", "a\nb\nc\n");
    git::stage(d, &["src/b.ts".into()]).await.unwrap();
    assert_eq!(git::status(d).await.unwrap().staged, vec![ch("src/b.ts", 'M', Some((1, 0)))]);
    git(&dir, &["reset", "-q", "--hard"]);

    // lists tracked files and leaves untracked ones to status
    write(&dir, "scratch.tmp", "x\n");
    let list = git::files(d).await.unwrap();
    assert!(list.contains(&"a.txt".to_string()));
    assert!(!list.contains(&"scratch.tmp".to_string()));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn parses_porcelain_status_including_renames_and_conflicts() {
    let st = git::parse_status("M  a.txt\0 M b.txt\0R  new.txt\0old.txt\0?? c.txt\0UU d.txt\0");
    assert_eq!(st.staged, vec![ch("a.txt", 'M', None), ch("new.txt", 'M', None)]);
    assert_eq!(
        st.unstaged,
        vec![
            ch("b.txt", 'M', None),
            ch("c.txt", '?', None),
            FileChange {
                conflict: Some(true),
                ..ch("d.txt", 'M', None)
            }
        ]
    );
}

#[test]
fn names_a_missing_or_too_old_git_and_accepts_current_ones() {
    assert!(git::git_problem("").unwrap().contains("needs git. Install"));
    assert!(git::git_problem("git version 2.22.5").unwrap().contains("2.23 or newer, and this is git 2.22"));
    assert_eq!(git::git_problem("git version 2.50.1 (Apple Git-155)"), None);
    assert_eq!(git::git_problem("git version 2.45.1.windows.1"), None);
}

#[tokio::test]
async fn rebase_with_local_changes() {
    let repo = tmp("ramulus-rebase-");
    let r = s(&repo);
    init(&repo);
    write(&repo, "a.txt", "one\ntwo\n");
    write(&repo, "b.txt", "base\n");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "base"]);
    git(&repo, &["checkout", "-qb", "feature"]);
    write(&repo, "f.txt", "feature\n");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "feature work"]);
    git(&repo, &["checkout", "-q", "main"]);
    write(&repo, "a.txt", "ONE\ntwo\n");
    git(&repo, &["commit", "-qam", "main work"]);
    git(&repo, &["checkout", "-q", "feature"]);
    let head = || git(&repo, &["rev-parse", "HEAD"]).trim().to_string();

    // stashes, rebases, reapplies, and undoes back to the original commit
    write(&repo, "b.txt", "local edit\n");
    let tip = head();
    let res = git::rebase(r, "main").await.unwrap();
    assert_eq!((res.result, res.before.as_str()), ("done", tip.as_str()));
    assert_eq!(read(&repo, "b.txt"), "local edit\n");
    assert_eq!(read(&repo, "a.txt"), "ONE\ntwo\n");
    assert_eq!(git::undo_rebase(r, &res.before).await.unwrap(), "done");
    assert_eq!(head(), tip);
    assert_eq!(read(&repo, "b.txt"), "local edit\n");
    assert_eq!(git(&repo, &["stash", "list"]), "");

    // keeps the changes when putting them back conflicts, and undo restores them
    write(&repo, "a.txt", "mine\ntwo\n");
    let tip = head();
    let res = git::rebase(r, "main").await.unwrap();
    assert_eq!(res.result, "stash-conflicts");
    assert!(git(&repo, &["stash", "list"]).contains("autostash"));
    let a = read(&repo, "a.txt");
    assert!(a.contains("<<<<<<<") || a.contains("mine"));
    write(&repo, "b.txt", "after rebase\n");
    assert_eq!(git::undo_rebase(r, &res.before).await.unwrap(), "done");
    assert_eq!(head(), tip);
    assert_eq!(read(&repo, "a.txt"), "mine\ntwo\n");
    assert_eq!(git(&repo, &["stash", "list", "--format=%gs"]).trim(), "On feature: Backup before undoing the rebase");
    assert_eq!(git(&repo, &["show", "stash@{0}:b.txt"]), "after rebase\n");
    git(&repo, &["stash", "drop", "-q"]);

    // refuses to undo once the branch moved after the rebase
    git(&repo, &["checkout", "-q", "--", "."]);
    let res = git::rebase(r, "main").await.unwrap();
    git(&repo, &["rebase", "-q", "--force-rebase", "main"]);
    assert!(git::undo_rebase(r, &res.before).await.unwrap_err().0.contains("changed after the rebase"));
    write(&repo, "c.txt", "later\n");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "later work"]);
    assert!(git::undo_rebase(r, &res.before).await.unwrap_err().0.contains("changed after the rebase"));

    // stops instead of overwriting an untracked file
    git(&repo, &["checkout", "-q", "main"]);
    git(&repo, &["rm", "-q", "b.txt"]);
    git(&repo, &["commit", "-qm", "drop b"]);
    git(&repo, &["checkout", "-q", "feature"]);
    let res = git::rebase(r, "main").await.unwrap();
    assert_eq!(res.result, "done");
    write(&repo, "b.txt", "new work\n");
    write(&repo, "f.txt", "tracked edit\n");
    let tip = head();
    assert!(git::undo_rebase(r, &res.before).await.unwrap_err().0.contains("b.txt"));
    assert_eq!(head(), tip);
    assert_eq!(read(&repo, "b.txt"), "new work\n");
    assert_eq!(read(&repo, "f.txt"), "tracked edit\n");
    assert_eq!(git(&repo, &["stash", "list"]), "");
    std::fs::remove_dir_all(&repo).unwrap();
}

#[tokio::test]
async fn push_when_the_remote_moved_on() {
    let root = tmp("ramulus-push-");
    git(&root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
    git(&root, &["clone", "-q", "remote.git", "mine"]);
    let (mine, theirs) = (root.join("mine"), root.join("theirs"));
    identity(&mine);
    write(&mine, "a.txt", "a\n");
    git(&mine, &["add", "."]);
    git(&mine, &["commit", "-qm", "base"]);
    git(&mine, &["push", "-q", "origin", "main"]);
    git(&root, &["clone", "-q", "remote.git", "theirs"]);
    write(&theirs, "b.txt", "theirs\n");
    git(&theirs, &["add", "."]);
    git(&theirs, &["commit", "-qm", "their work"]);
    git(&theirs, &["push", "-q"]);
    write(&mine, "c.txt", "mine\n");
    git(&mine, &["add", "."]);
    git(&mine, &["commit", "-qm", "my work"]);
    let remote_tip = || git(&root, &["--git-dir", "remote.git", "rev-parse", "main"]).trim().to_string();
    let m = s(&mine);

    // reports a rejected push with counts, then force pushes only over the commit it counted
    let r = git::push(m, None).await.unwrap();
    assert_eq!(
        r,
        PushResult::Rejected {
            result: "rejected",
            ahead: 1,
            behind: 1,
            theirs: remote_tip()
        }
    );
    let PushResult::Rejected { theirs: counted, .. } = r else { unreachable!() };
    write(&theirs, "d.txt", "more\n");
    git(&theirs, &["add", "."]);
    git(&theirs, &["commit", "-qm", "their second"]);
    git(&theirs, &["push", "-q"]);
    git(&mine, &["fetch", "-q"]);
    let e = git::push(m, Some(&counted)).await.unwrap_err().0;
    assert!(e.contains("stale info") || e.contains("rejected"), "{e}");
    let again = git::push(m, None).await.unwrap();
    let PushResult::Rejected { theirs, behind, .. } = again else { panic!("{again:?}") };
    assert_eq!((theirs.as_str(), behind), (remote_tip().as_str(), 2));
    assert_eq!(git::push(m, Some(&theirs)).await.unwrap(), PushResult::Pushed { result: "pushed" });
    assert_eq!(remote_tip(), git(&mine, &["rev-parse", "HEAD"]).trim());
    std::fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn switching_to_a_remote_branch() {
    let root = tmp("ramulus-remote-");
    git(&root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
    git(&root, &["clone", "-q", "-c", "core.autocrlf=false", "remote.git", "mine"]);
    let (mine, theirs) = (root.join("mine"), root.join("theirs"));
    identity(&mine);
    write(&mine, "a.txt", "one\n");
    write(&mine, "b.txt", "b\n");
    git(&mine, &["add", "."]);
    git(&mine, &["commit", "-qm", "base"]);
    git(&mine, &["push", "-q", "origin", "main"]);
    git(&mine, &["switch", "-q", "-c", "feature"]);
    git(&mine, &["push", "-q", "-u", "origin", "feature"]);
    git(&root, &["clone", "-q", "-c", "core.autocrlf=false", "remote.git", "theirs"]);
    let their_commit = |branch: &str, file: &str, text: &str| {
        git(&theirs, &["switch", "-q", branch]);
        write(&theirs, file, text);
        git(&theirs, &["commit", "-qam", &format!("edit {file}")]);
        git(&theirs, &["push", "-q", "origin", branch]);
        git(&mine, &["fetch", "-q"]);
    };
    let m = s(&mine);
    let switched = |result: &'static str, local: &str, ahead: u64, behind: u64, stash: Option<&'static str>| RemoteSwitch {
        result,
        local: local.into(),
        ahead: Some(ahead),
        behind: Some(behind),
        stash,
    };

    // fast-forwards the local branch and keeps uncommitted and staged changes
    their_commit("feature", "a.txt", "one\ntwo\n");
    git(&mine, &["switch", "-q", "main"]);
    write(&mine, "b.txt", "b changed\n");
    git(&mine, &["add", "b.txt"]);
    assert_eq!(git::checkout_remote(m, "origin/feature").await.unwrap(), switched("updated", "feature", 0, 1, Some("kept")));
    assert_eq!(git(&mine, &["branch", "--show-current"]).trim(), "feature");
    assert_eq!(read(&mine, "a.txt"), "one\ntwo\n");
    assert_eq!(git(&mine, &["status", "--porcelain"]), "M  b.txt\n");
    assert_eq!(git(&mine, &["stash", "list"]), "");
    git(&mine, &["reset", "-q", "--hard"]);

    // creates a tracking branch when there is no local one
    git(&theirs, &["switch", "-q", "-c", "fresh"]);
    git(&theirs, &["push", "-q", "-u", "origin", "fresh"]);
    git(&mine, &["fetch", "-q"]);
    assert_eq!(
        git::checkout_remote(m, "origin/fresh").await.unwrap(),
        RemoteSwitch {
            result: "created",
            local: "fresh".into(),
            ahead: None,
            behind: None,
            stash: None
        }
    );
    assert_eq!(git(&mine, &["rev-parse", "--abbrev-ref", "@{u}"]).trim(), "origin/fresh");

    // switches without rewriting anything when both sides have commits
    git(&mine, &["switch", "-q", "feature"]);
    write(&mine, "c.txt", "mine\n");
    git(&mine, &["add", "."]);
    git(&mine, &["commit", "-qm", "my work"]);
    let tip = git(&mine, &["rev-parse", "HEAD"]).trim().to_string();
    their_commit("feature", "a.txt", "one\ntwo\nthree\n");
    git(&mine, &["switch", "-q", "main"]);
    assert_eq!(git::checkout_remote(m, "origin/feature").await.unwrap().result, "diverged");
    assert_eq!(git(&mine, &["rev-parse", "HEAD"]).trim(), tip);

    // puts the changes back when the switch itself fails
    git(&theirs, &["switch", "-q", "-c", "blocked", "origin/main"]);
    write(&theirs, "c.txt", "theirs\n");
    git(&theirs, &["add", "."]);
    git(&theirs, &["commit", "-qm", "add c"]);
    git(&theirs, &["push", "-q", "-u", "origin", "blocked"]);
    git(&mine, &["fetch", "-q"]);
    git(&mine, &["switch", "-q", "main"]);
    git(&mine, &["reset", "-q", "--hard"]);
    write(&mine, "a.txt", "edited\n");
    write(&mine, "c.txt", "untracked\n");
    let e = git::checkout_remote(m, "origin/blocked").await.unwrap_err().0.to_lowercase();
    assert!(e.contains("untracked") || e.contains("overwritten"), "{e}");
    assert_eq!(git(&mine, &["branch", "--show-current"]).trim(), "main");
    assert_eq!(read(&mine, "a.txt"), "edited\n");
    assert_eq!(read(&mine, "c.txt"), "untracked\n");
    assert_eq!(git(&mine, &["stash", "list"]), "");
    std::fs::remove_file(mine.join("c.txt")).unwrap();
    git(&mine, &["reset", "-q", "--hard"]);

    // keeps the changes in the stash when putting them back conflicts
    git(&mine, &["switch", "-q", "main"]);
    their_commit("main", "b.txt", "theirs\n");
    git(&mine, &["reset", "-q", "--hard", "HEAD"]);
    write(&mine, "b.txt", "mine\n");
    let r = git::checkout_remote(m, "origin/main").await.unwrap();
    assert_eq!((r.result, r.stash), ("updated", Some("conflicts")));
    assert!(git(&mine, &["stash", "list"]).contains("autostash"));
    let b = read(&mine, "b.txt");
    assert!(b.contains("<<<<<<<") || b.contains("mine"));
    std::fs::remove_dir_all(&root).unwrap();
}
