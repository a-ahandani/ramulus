use crate::{err, Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const NUL: char = '\0';
const RS: char = '\x1e';
const MAX_TEXT: u64 = 2_000_000;
const CHANGED: &str = "The file changed since this diff was loaded. Look at it again and retry.";

pub struct Out {
    pub ok: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Out {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn trimmed(&self) -> String {
        self.text().trim().to_string()
    }
    fn failure(&self) -> String {
        let e = self.stderr.trim();
        if e.is_empty() {
            self.trimmed()
        } else {
            e.to_string()
        }
    }
}

/// Runs git and reports success or failure without turning a failure into an error.
pub async fn try_run(dir: &str, args: &[&str], input: Option<&[u8]>) -> Result<Out> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(crate::NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| Error(format!("git {}: {e}", args.first().unwrap_or(&""))))?;
    let stdin = child.stdin.take();
    let input = input.map(<[u8]>::to_vec);
    let feed = async move {
        if let (Some(mut stdin), Some(data)) = (stdin, input) {
            let _ = stdin.write_all(&data).await;
        }
    };
    let (out, ()) = tokio::join!(child.wait_with_output(), feed);
    let out = out?;
    Ok(Out {
        ok: out.status.success(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Runs git and fails with git's own message when it exits non-zero.
pub async fn run(dir: &str, args: &[&str], input: Option<&[u8]>) -> Result<Out> {
    let out = try_run(dir, args, input).await?;
    if out.ok {
        return Ok(out);
    }
    let msg = out.failure();
    err(if msg.is_empty() { format!("git {} failed", args.first().unwrap_or(&"")) } else { msg })
}

async fn text(dir: &str, args: &[&str]) -> Result<String> {
    Ok(run(dir, args, None).await?.trimmed())
}

async fn text_or_empty(dir: &str, args: &[&str]) -> Result<String> {
    Ok(try_run(dir, args, None).await?.trimmed())
}

pub fn safe_name(name: &str) -> Result<&str> {
    if name.is_empty() || name.starts_with('-') {
        return err(format!("Invalid name: {}", serde_json::to_string(name).unwrap_or_default()));
    }
    Ok(name)
}

pub fn safe_paths(paths: &[String]) -> Result<Vec<&str>> {
    if paths.is_empty() {
        return err("No files given");
    }
    paths.iter().map(|p| if p.is_empty() { err("Invalid path") } else { Ok(p.as_str()) }).collect()
}

pub fn git_problem(version_text: &str) -> Option<String> {
    let digits = |s: &str| -> Option<(u32, usize)> {
        let n: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        if n.is_empty() {
            None
        } else {
            Some((n.parse().ok()?, n.len()))
        }
    };
    let mut found = None;
    for (i, _) in version_text.char_indices().filter(|(_, c)| c.is_ascii_digit()) {
        if let Some((major, n)) = digits(&version_text[i..]) {
            if let Some((minor, _)) = version_text[i + n..].strip_prefix('.').and_then(digits) {
                found = Some((major, minor));
                break;
            }
        }
    }
    match found {
        None => Some("Ramulus needs git. Install it from https://git-scm.com/downloads and run it again.".into()),
        Some((major, minor)) if major < 2 || (major == 2 && minor < 23) => Some(format!(
            "Ramulus needs git 2.23 or newer, and this is git {major}.{minor}. Update it from https://git-scm.com/downloads"
        )),
        Some(_) => None,
    }
}

pub async fn files(dir: &str) -> Result<Vec<String>> {
    let out = run(dir, &["ls-files", "-z"], None).await?.text();
    let mut seen = HashSet::new();
    Ok(out.split(NUL).filter(|s| !s.is_empty() && seen.insert(s.to_string())).map(str::to_string).collect())
}

pub async fn toplevel(dir: &str) -> Result<String> {
    text(dir, &["rev-parse", "--show-toplevel"]).await
}

pub type RepoState = Option<&'static str>;

async fn state_of(dir: &str) -> Result<RepoState> {
    let git_dir = text(dir, &["rev-parse", "--git-dir"]).await?;
    let base = Path::new(dir).join(git_dir);
    let at = |p: &str| base.join(p).exists();
    Ok(if at("MERGE_HEAD") {
        Some("merge")
    } else if at("rebase-merge") || at("rebase-apply") {
        Some("rebase")
    } else if at("CHERRY_PICK_HEAD") {
        Some("cherry-pick")
    } else if at("REVERT_HEAD") {
        Some("revert")
    } else {
        None
    })
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FileChange {
    pub path: String,
    pub kind: char,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<u64>,
}

fn change(path: &str, kind: char) -> FileChange {
    FileChange {
        path: path.to_string(),
        kind,
        conflict: None,
        added: None,
        deleted: None,
    }
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct WorkStatus {
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub state: RepoState,
}

pub fn parse_status(porcelain_z: &str) -> WorkStatus {
    let mut out = WorkStatus::default();
    let items: Vec<&str> = porcelain_z.split(NUL).collect();
    let mut i = 0;
    while i < items.len() {
        let item = items[i];
        i += 1;
        if item.chars().count() < 4 {
            continue;
        }
        let mut cs = item.chars();
        let (x, y) = (cs.next().unwrap_or(' '), cs.next().unwrap_or(' '));
        let path = &item[3..];
        if x == 'R' || x == 'C' {
            i += 1;
        }
        if x == '?' {
            out.unstaged.push(change(path, '?'));
            continue;
        }
        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            out.unstaged.push(FileChange {
                conflict: Some(true),
                ..change(path, 'M')
            });
            continue;
        }
        if x != ' ' {
            out.staged.push(change(
                path,
                if x == 'A' {
                    'A'
                } else if x == 'D' {
                    'D'
                } else {
                    'M'
                },
            ));
        }
        if y != ' ' {
            out.unstaged.push(change(path, if y == 'D' { 'D' } else { 'M' }));
        }
    }
    out
}

fn parse_numstat(text: &str) -> HashMap<String, (u64, u64)> {
    let num = |s: &str| if s == "-" { 0 } else { s.parse().unwrap_or(0) };
    let mut out = HashMap::new();
    for line in text.split('\n') {
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        out.insert(renamed_to(path), (num(a), num(d)));
    }
    out
}

/// The new path of a numstat rename, written as `src/{a.ts => b.ts}` or `a.ts => b.ts`; other paths come back as they are.
fn renamed_to(path: &str) -> String {
    fn after(s: &str) -> &str {
        s.rsplit(" => ").next().unwrap_or(s)
    }
    match (path.find('{'), path.find('}')) {
        (Some(l), Some(r)) if l < r => format!("{}{}{}", &path[..l], after(&path[l + 1..r]), &path[r + 1..]),
        _ => after(path).to_string(),
    }
}

fn with_stats(files: &mut [FileChange], stats: &HashMap<String, (u64, u64)>) {
    for f in files {
        if let Some((a, d)) = stats.get(&f.path) {
            f.added = Some(*a);
            f.deleted = Some(*d);
        }
    }
}

pub async fn status(dir: &str) -> Result<WorkStatus> {
    let (st, unstaged, staged, state) = tokio::join!(
        run(dir, &["status", "--porcelain=v1", "-z", "--untracked-files=all"], None),
        try_run(dir, &["diff", "--numstat", "-M"], None),
        try_run(dir, &["diff", "--numstat", "-M", "--cached"], None),
        state_of(dir),
    );
    let mut parsed = parse_status(&st?.text());
    with_stats(&mut parsed.unstaged, &parse_numstat(&unstaged?.text()));
    with_stats(&mut parsed.staged, &parse_numstat(&staged?.text()));
    parsed.state = state?;
    Ok(parsed)
}

#[derive(Serialize, Debug)]
pub struct Commit {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub summary: String,
    pub body: String,
    pub kind: &'static str,
}

pub fn parse_log(text: &str, internals: &HashSet<String>, messages: &HashMap<String, String>) -> Vec<Commit> {
    let mut commits = Vec::new();
    for rec in text.split(RS) {
        let t = rec.strip_prefix('\n').unwrap_or(rec);
        if t.trim().is_empty() {
            continue;
        }
        let mut f = t.split(NUL);
        let mut next = || f.next().unwrap_or("");
        let id = next();
        if id.is_empty() || internals.contains(id) {
            continue;
        }
        let (parents, author, email, time, summary, body) = (next(), next(), next(), next(), next(), next());
        let stash = messages.get(id);
        let mut ps: Vec<String> = if parents.is_empty() { vec![] } else { parents.split(' ').map(str::to_string).collect() };
        if stash.is_some() {
            ps.truncate(1);
        }
        let kind = if stash.is_some() {
            "stash"
        } else if ps.len() > 1 {
            "merge"
        } else {
            "commit"
        };
        commits.push(Commit {
            id: id.to_string(),
            parents: ps,
            author: author.to_string(),
            email: email.to_string(),
            time: time.parse().unwrap_or(0),
            summary: stash.cloned().unwrap_or_else(|| summary.to_string()),
            body: body.trim().to_string(),
            kind,
        });
    }
    commits
}

#[derive(Serialize, Debug)]
pub struct RefLabel {
    pub name: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<bool>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub oid: String,
    pub is_head: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gone: Option<bool>,
}

#[derive(Serialize, Debug)]
pub struct Tag {
    pub name: String,
    pub oid: String,
}

#[derive(Serialize, Debug)]
pub struct StashInfo {
    pub index: usize,
    pub message: String,
    pub oid: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoData {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_oid: Option<String>,
    /// where `origin` points, so the toolbar can show the GitHub owner's avatar
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_url: Option<String>,
    pub commits: Vec<Commit>,
    pub refs_by_oid: HashMap<String, Vec<RefLabel>>,
    pub local: Vec<BranchInfo>,
    pub remote: Vec<BranchInfo>,
    pub tags: Vec<Tag>,
    pub stashes: Vec<StashInfo>,
    pub status: WorkStatus,
    pub has_more: bool,
    pub native: bool,
}

fn count_after(track: &str, word: &str) -> u64 {
    track
        .find(word)
        .map(|i| track[i + word.len()..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

pub async fn load(dir: &str, limit: usize) -> Result<RepoData> {
    let refs_args = [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(symref)%00%(upstream:short)%00%(upstream:track)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    ];
    // these read different things, so they run at once; the log waits for the stash list it must skip past
    let (head_branch, head_oid, origin_url, refs, stash_list, status) = tokio::join!(
        text_or_empty(dir, &["symbolic-ref", "-q", "--short", "HEAD"]),
        text_or_empty(dir, &["rev-parse", "-q", "--verify", "HEAD"]),
        text_or_empty(dir, &["remote", "get-url", "origin"]),
        run(dir, &refs_args, None),
        try_run(dir, &["stash", "list", "--format=%H%x00%s"], None),
        status(dir),
    );
    let head_branch = Some(head_branch?).filter(|s| !s.is_empty());
    let head_oid = Some(head_oid?).filter(|s| !s.is_empty());
    let origin_url = Some(origin_url?).filter(|s| !s.is_empty());
    let mut refs_by_oid: HashMap<String, Vec<RefLabel>> = HashMap::new();
    let (mut local, mut remote, mut tags) = (vec![], vec![], vec![]);
    let refs = refs?.text();
    for line in refs.split('\n').filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split(NUL).collect();
        let get = |i: usize| f.get(i).copied().unwrap_or("");
        let (refname, objectname, peeled, symref, upstream, track) = (get(0), get(1), get(2), get(3), get(4), get(5));
        if !symref.is_empty() {
            continue;
        }
        let oid = if peeled.is_empty() { objectname } else { peeled };
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            let current = head_branch.as_deref() == Some(name);
            local.push(BranchInfo {
                name: name.into(),
                oid: oid.into(),
                is_head: current,
                upstream: Some(upstream.to_string()).filter(|u| !u.is_empty()),
                ahead: Some(count_after(track, "ahead ")),
                behind: Some(count_after(track, "behind ")),
                gone: Some(track.contains("gone")),
            });
            refs_by_oid.entry(oid.into()).or_default().push(RefLabel {
                name: name.into(),
                kind: "head",
                current: Some(current),
            });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            remote.push(BranchInfo {
                name: name.into(),
                oid: oid.into(),
                is_head: false,
                upstream: None,
                ahead: None,
                behind: None,
                gone: None,
            });
            refs_by_oid.entry(oid.into()).or_default().push(RefLabel {
                name: name.into(),
                kind: "remote",
                current: None,
            });
        } else if let Some(name) = refname.strip_prefix("refs/tags/") {
            tags.push(Tag {
                name: name.into(),
                oid: oid.into(),
            });
            refs_by_oid.entry(oid.into()).or_default().push(RefLabel {
                name: name.into(),
                kind: "tag",
                current: None,
            });
        }
    }
    let mut stashes = vec![];
    for line in stash_list?.text().split('\n').filter(|l| !l.is_empty()) {
        let (oid, message) = line.split_once(NUL).unwrap_or((line, ""));
        stashes.push(StashInfo {
            index: stashes.len(),
            message: message.into(),
            oid: oid.into(),
        });
    }
    let mut internals = HashSet::new();
    if !stashes.is_empty() {
        let mut args = vec!["rev-list", "--no-walk", "--parents"];
        args.extend(stashes.iter().map(|s| s.oid.as_str()));
        for line in run(dir, &args, None).await?.text().split('\n') {
            // the first parent is the commit the stash was made on; the rest are the stash's own index and untracked commits
            internals.extend(line.trim().split(' ').skip(2).map(str::to_string));
        }
    }
    let max = format!("--max-count={}", limit + 1 + internals.len());
    let log = try_run(dir, &["log", "--date-order", &max, "--format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%s%x00%b%x1e", "--all"], None).await?;
    let messages = stashes.iter().map(|s| (s.oid.clone(), s.message.clone())).collect();
    let mut commits = parse_log(&log.text(), &internals, &messages);
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(RepoData {
        name: dir.split(['/', '\\']).rfind(|s: &&str| !s.is_empty()).unwrap_or("").to_string(),
        head_branch,
        head_oid,
        origin_url,
        commits,
        refs_by_oid,
        local,
        remote,
        tags,
        stashes,
        status: status?,
        has_more,
        native: true,
    })
}

async fn parent_of(dir: &str, oid: &str) -> Result<Option<String>> {
    Ok(Some(text_or_empty(dir, &["rev-parse", "-q", "--verify", &format!("{oid}^")]).await?).filter(|s| !s.is_empty()))
}

pub async fn commit_files(dir: &str, oid: &str) -> Result<Vec<FileChange>> {
    safe_name(oid)?;
    let parent = parent_of(dir, oid).await?;
    let args: Vec<&str> = match &parent {
        Some(p) => vec!["diff-tree", "-r", "-z", "-M", "--name-status", p, oid],
        None => vec!["diff-tree", "--root", "--no-commit-id", "-r", "-z", "-M", "--name-status", oid],
    };
    let stat_args: Vec<&str> = args.iter().filter(|a| **a != "-z").map(|a| if *a == "--name-status" { "--numstat" } else { *a }).collect();
    let (out, stats) = tokio::join!(run(dir, &args, None), try_run(dir, &stat_args, None));
    let text = out?.text();
    let parts: Vec<&str> = text.split(NUL).collect();
    let mut files = vec![];
    let mut i = 0;
    while i + 1 < parts.len() {
        let code = parts[i].chars().next().unwrap_or(' ');
        let mut path = parts[i + 1];
        if code == 'R' || code == 'C' {
            path = parts.get(i + 2).copied().unwrap_or("");
            i += 1;
        }
        i += 2;
        if !path.is_empty() {
            files.push(change(
                path,
                match code {
                    'A' => 'A',
                    'D' => 'D',
                    _ => 'M',
                },
            ));
        }
    }
    with_stats(&mut files, &parse_numstat(&stats?.text()));
    Ok(files)
}

enum Blob {
    Big,
    Data(Vec<u8>),
}

fn is_binary(buf: &[u8]) -> bool {
    buf.iter().take(8000).any(|b| *b == 0)
}

async fn show_bytes(dir: &str, spec: &str) -> Result<Option<Blob>> {
    let size = try_run(dir, &["cat-file", "-s", spec], None).await?;
    if !size.ok {
        return Ok(None);
    }
    if size.trimmed().parse::<u64>().unwrap_or(0) > MAX_TEXT {
        return Ok(Some(Blob::Big));
    }
    let r = try_run(dir, &["cat-file", "--filters", spec], None).await?;
    Ok(if r.ok { Some(Blob::Data(r.stdout)) } else { None })
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DiffArea {
    Commit { oid: String },
    Staged,
    Unstaged,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FileVersions {
    pub old: String,
    pub new: String,
    pub binary: bool,
}

fn safe_path(path: &str) -> Result<()> {
    if path.is_empty() {
        err("Invalid path")
    } else {
        Ok(())
    }
}

pub async fn file_versions(dir: &str, area: &DiffArea, path: &str) -> Result<FileVersions> {
    safe_path(path)?;
    let (old, new) = match area {
        DiffArea::Commit { oid } => {
            let old = match parent_of(dir, oid).await? {
                Some(p) => show_bytes(dir, &format!("{p}:{path}")).await?,
                None => None,
            };
            (old, show_bytes(dir, &format!("{}:{path}", safe_name(oid)?)).await?)
        }
        DiffArea::Staged => (show_bytes(dir, &format!("HEAD:{path}")).await?, show_bytes(dir, &format!(":{path}")).await?),
        DiffArea::Unstaged => {
            let old = match show_bytes(dir, &format!(":{path}")).await? {
                Some(b) => Some(b),
                None => show_bytes(dir, &format!("HEAD:{path}")).await?,
            };
            let full = inside_repo(dir, path)?;
            let new = match tokio::fs::symlink_metadata(&full).await {
                Err(_) => None,
                Ok(m) if m.file_type().is_symlink() || m.len() > MAX_TEXT => Some(Blob::Big),
                Ok(_) => Some(Blob::Data(tokio::fs::read(&full).await?)),
            };
            (old, new)
        }
    };
    let binary = [&old, &new]
        .iter()
        .any(|b| matches!(b, Some(Blob::Big)) || matches!(b, Some(Blob::Data(d)) if is_binary(d)));
    let txt = |b: &Option<Blob>| match b {
        Some(Blob::Data(d)) if !binary => String::from_utf8_lossy(d).into_owned(),
        _ => String::new(),
    };
    Ok(FileVersions {
        old: txt(&old),
        new: txt(&new),
        binary,
    })
}

pub async fn write_index(dir: &str, path: &str, content: &str, expected: Option<&str>) -> Result<()> {
    safe_path(path)?;
    if let Some(expected) = expected {
        let cur = match show_bytes(dir, &format!(":{path}")).await? {
            Some(Blob::Data(d)) => String::from_utf8_lossy(&d).into_owned(),
            _ => String::new(),
        };
        if cur != expected {
            return err(CHANGED);
        }
    }
    let oid = run(dir, &["hash-object", "-w", "--stdin", &format!("--path={path}")], Some(content.as_bytes()))
        .await?
        .trimmed();
    let entry = try_run(dir, &["ls-files", "-s", "--", path], None).await?.trimmed();
    let mode = entry.split(' ').next().filter(|m| !m.is_empty()).unwrap_or("100644");
    run(dir, &["update-index", "--add", "--cacheinfo", &format!("{mode},{oid},{path}")], None).await?;
    Ok(())
}

fn inside_repo(dir: &str, path: &str) -> Result<PathBuf> {
    let base = crate::resolve(Path::new(dir), Path::new(""));
    let full = crate::resolve(Path::new(dir), Path::new(path));
    if full == base || !full.starts_with(&base) {
        return err("Path is outside the repository");
    }
    Ok(full)
}

pub async fn write_workdir(dir: &str, path: &str, content: &str, expected: Option<&str>) -> Result<()> {
    safe_path(path)?;
    let full = inside_repo(dir, path)?;
    if tokio::fs::symlink_metadata(&full).await.map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return err("That path is a symbolic link");
    }
    if let Some(expected) = expected {
        let cur = tokio::fs::read(&full).await.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        if cur != expected {
            return err(CHANGED);
        }
    }
    tokio::fs::write(&full, content).await?;
    Ok(())
}

fn cap(text: String, n: usize) -> String {
    if text.len() <= n {
        return text;
    }
    let mut cut = n;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n[{} more characters left out]", &text[..cut], text.len() - cut)
}

pub async fn ai_context(dir: &str, task: &str, at: Option<&str>) -> Result<String> {
    let recent = format!("Recent commit subjects:\n{}", text_or_empty(dir, &["log", "-15", "--format=%s"]).await?);
    match task {
        "commit" => {
            let stat = text_or_empty(dir, &["diff", "--cached", "--stat"]).await?;
            let diff = text_or_empty(dir, &["diff", "--cached"]).await?;
            Ok(format!("{recent}\n\nStaged changes:\n{}", cap(format!("{stat}\n\n{diff}"), 80000)))
        }
        "branch" => {
            let branches = text_or_empty(dir, &["branch", "-a", "--format=%(refname:short)"])
                .await?
                .split('\n')
                .take(80)
                .collect::<Vec<_>>()
                .join("\n");
            let at = match at {
                Some(a) => format!(
                    "\n\nThe new branch starts at this commit:\n{}",
                    text_or_empty(dir, &["log", "-1", "--format=%s%n%n%b", safe_name(a)?]).await?
                ),
                None => String::new(),
            };
            let short = text_or_empty(dir, &["status", "--short"]).await?;
            let diff = text_or_empty(dir, &["diff", "HEAD"]).await?;
            Ok(format!(
                "Existing branches:\n{branches}{at}\n\nUncommitted changes:\n{}",
                cap(format!("{short}\n\n{diff}"), 80000)
            ))
        }
        _ => err("Unknown task"),
    }
}

pub async fn find_repos(root: &str, depth: usize, limit: usize) -> Vec<String> {
    let root = PathBuf::from(root);
    tokio::task::spawn_blocking(move || find_repos_sync(&root, depth, limit)).await.unwrap_or_default()
}

fn find_repos_sync(root: &Path, depth: usize, limit: usize) -> Vec<String> {
    let mut found = vec![];
    let mut level = vec![root.to_path_buf()];
    for _ in 0..depth {
        if level.is_empty() || found.len() >= limit {
            break;
        }
        let mut next = vec![];
        'level: for dir in &level {
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) || name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                let full = e.path();
                if full.join(".git").exists() {
                    found.push(full.to_string_lossy().into_owned());
                } else {
                    next.push(full);
                }
                if found.len() >= limit {
                    break 'level;
                }
            }
        }
        level = next;
    }
    found.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
    found
}

// the hidden TopMost owner keeps the dialog above the browser; without one Windows opens it behind
const WIN_PICKER: &str = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost = $true})) -eq 'OK') { $d.SelectedPath }";

pub async fn pick_folder() -> Result<Option<String>> {
    let (cmd, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("osascript", vec!["-e", "POSIX path of (choose folder with prompt \"Open a repository\")"])
    } else if cfg!(windows) {
        ("powershell", vec!["-NoProfile", "-Command", WIN_PICKER])
    } else {
        ("zenity", vec!["--file-selection", "--directory", "--title=Open a repository"])
    };
    match Command::new(cmd).args(&args).stdin(Stdio::null()).output().await {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => err("No folder picker is available here. Type the path instead."),
        Err(_) => Ok(None),
        Ok(o) if o.status.success() => Ok(Some(String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty())),
        Ok(_) => Ok(None),
    }
}

/// Opens a file or URL with the system's default handler; the child is reaped in the background.
pub fn open_external(target: &OsStr) -> Result<()> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(target);
        c
    } else if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/c", "start", ""]).arg(target);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(target);
        c
    };
    detach(&mut cmd);
    Ok(())
}

/// Spawns a launcher and lets it go; nothing here waits for the window it opens.
fn detach(cmd: &mut Command) {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(crate::NO_WINDOW);
    let _ = cmd.spawn();
}

pub fn open_path(dir: &str, path: &str) -> Result<()> {
    safe_path(path)?;
    let full = inside_repo(dir, path)?;
    if !full.exists() {
        return err("That file no longer exists");
    }
    open_external(full.as_os_str())
}

/// Shows a path in the desktop's file manager: a folder opens, a file is selected inside its own.
#[cfg(target_os = "macos")]
async fn show_in_manager(target: &Path) -> Result<()> {
    let mut cmd = Command::new("open");
    if target.is_dir() {
        cmd.arg(target);
    } else {
        cmd.arg("-R").arg(target);
    }
    detach(&mut cmd);
    Ok(())
}

/// Shows a path in the desktop's file manager: a folder opens, a file is selected inside its own.
#[cfg(windows)]
async fn show_in_manager(target: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt as _;
    // Explorer parses its own command line and wants the path quoted on its own. The quoting Rust
    // would apply wraps the whole /select, token instead, which Explorer does not understand.
    let arg = if target.is_dir() {
        format!("\"{}\"", target.display())
    } else {
        format!("/select,\"{}\"", target.display())
    };
    let mut cmd = Command::new("explorer");
    cmd.as_std_mut().raw_arg(arg);
    detach(&mut cmd);
    Ok(())
}

/// Shows a path in the desktop's file manager: a folder opens, a file is selected inside its own.
#[cfg(not(any(windows, target_os = "macos")))]
async fn show_in_manager(target: &Path) -> Result<()> {
    // The freedesktop interface selects the file itself; a desktop without it gets the folder.
    if !target.is_dir() {
        let items = format!("array:string:file://{}", target.display());
        let mut probe = Command::new("dbus-send");
        probe
            .args([
                "--session",
                "--dest=org.freedesktop.FileManager1",
                "--type=method_call",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                items.as_str(),
                "string:",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if probe.status().await.is_ok_and(|s| s.success()) {
            return Ok(());
        }
    }
    let mut cmd = Command::new("xdg-open");
    cmd.arg(if target.is_dir() { target } else { target.parent().unwrap_or(target) });
    detach(&mut cmd);
    Ok(())
}

/// Shows a file in the file manager, or the repository's own folder when the path is empty.
pub async fn reveal_path(dir: &str, path: &str) -> Result<()> {
    let full = if path.is_empty() {
        crate::resolve(Path::new(dir), Path::new(""))
    } else {
        safe_path(path)?;
        inside_repo(dir, path)?
    };
    if !full.exists() {
        return err("That path no longer exists");
    }
    show_in_manager(&full).await
}

pub async fn stage(dir: &str, paths: &[String]) -> Result<()> {
    let mut args = vec!["add", "-A", "--"];
    args.extend(safe_paths(paths)?);
    run(dir, &args, None).await.map(drop)
}

pub async fn unstage(dir: &str, paths: &[String]) -> Result<()> {
    let mut args = vec!["reset", "-q", "--"];
    args.extend(safe_paths(paths)?);
    run(dir, &args, None).await.map(drop)
}

pub async fn discard(dir: &str, files: &[FileChange]) -> Result<()> {
    let tracked: Vec<String> = files.iter().filter(|f| f.kind != '?').map(|f| f.path.clone()).collect();
    let untracked: Vec<String> = files.iter().filter(|f| f.kind == '?').map(|f| f.path.clone()).collect();
    if !tracked.is_empty() {
        let mut args = vec!["checkout", "-q", "--"];
        args.extend(safe_paths(&tracked)?);
        run(dir, &args, None).await?;
    }
    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "-q", "--"];
        args.extend(safe_paths(&untracked)?);
        run(dir, &args, None).await?;
    }
    Ok(())
}

pub async fn commit(dir: &str, message: &str, amend: bool) -> Result<()> {
    if message.trim().is_empty() {
        return err("A commit message is required");
    }
    let mut args = vec!["commit", "-q", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    run(dir, &args, Some(message.as_bytes())).await.map(drop)
}

pub async fn checkout_branch(dir: &str, name: &str) -> Result<()> {
    run(dir, &["switch", "-q", safe_name(name)?], None).await.map(drop)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct RemoteSwitch {
    pub result: &'static str,
    pub local: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stash: Option<&'static str>,
}

fn counts(text: &str) -> (u64, u64) {
    let mut it = text.split_whitespace().map(|s| s.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0))
}

async fn switch_to_remote(dir: &str, name: &str, local: &str, exists: bool) -> Result<RemoteSwitch> {
    if !exists {
        run(dir, &["switch", "-q", "-c", local, "--track", name], None).await?;
        return Ok(RemoteSwitch {
            result: "created",
            local: local.into(),
            ahead: None,
            behind: None,
            stash: None,
        });
    }
    run(dir, &["switch", "-q", local], None).await?;
    let (ahead, behind) = counts(&text(dir, &["rev-list", "--left-right", "--count", &format!("HEAD...{name}")]).await?);
    if behind > 0 && ahead == 0 {
        run(dir, &["merge", "-q", "--ff-only", name], None).await?;
    }
    let result = if behind == 0 {
        "up-to-date"
    } else if ahead > 0 {
        "diverged"
    } else {
        "updated"
    };
    Ok(RemoteSwitch {
        result,
        local: local.into(),
        ahead: Some(ahead),
        behind: Some(behind),
        stash: None,
    })
}

pub async fn checkout_remote(dir: &str, name: &str) -> Result<RemoteSwitch> {
    safe_name(name)?;
    let local = &name[name.find('/').map(|i| i + 1).unwrap_or(0)..];
    let exists = try_run(dir, &["rev-parse", "-q", "--verify", &format!("refs/heads/{local}")], None).await?.ok;
    let dirty = !text(dir, &["status", "--porcelain", "-uno"]).await?.is_empty();
    if dirty {
        run(dir, &["stash", "push", "-q", "-m", "autostash"], None).await?;
    }
    let out = match switch_to_remote(dir, name, local, exists).await {
        Ok(out) => out,
        Err(e) => {
            if dirty {
                try_run(dir, &["stash", "pop", "-q", "--index"], None).await?;
            }
            return Err(e);
        }
    };
    if !dirty {
        return Ok(out);
    }
    let back = try_run(dir, &["stash", "pop", "-q", "--index"], None).await?.ok || (!has_unmerged(dir).await? && try_run(dir, &["stash", "pop", "-q"], None).await?.ok);
    Ok(RemoteSwitch {
        stash: Some(if back { "kept" } else { "conflicts" }),
        ..out
    })
}

pub async fn checkout_commit(dir: &str, oid: &str) -> Result<()> {
    run(dir, &["switch", "-q", "--detach", safe_name(oid)?], None).await.map(drop)
}

pub async fn create_branch(dir: &str, name: &str, at: &str, checkout: bool) -> Result<()> {
    run(dir, &["branch", "--", safe_name(name)?, safe_name(at)?], None).await?;
    if checkout {
        run(dir, &["switch", "-q", name], None).await?;
    }
    Ok(())
}

pub async fn delete_branch(dir: &str, name: &str) -> Result<()> {
    run(dir, &["branch", "-D", "--", safe_name(name)?], None).await.map(drop)
}

pub async fn delete_remote_branch(dir: &str, name: &str) -> Result<()> {
    let remotes = text(dir, &["remote"]).await?;
    let Some(remote) = remotes.lines().filter(|r| !r.is_empty() && name.starts_with(&format!("{r}/"))).max_by_key(|r| r.len()) else {
        return err(format!("No remote has the branch {}", serde_json::to_string(name).unwrap_or_default()));
    };
    run(dir, &["push", "--delete", "--", remote, safe_name(&name[remote.len() + 1..])?], None).await.map(drop)
}

pub async fn rename_branch(dir: &str, old_name: &str, new_name: &str) -> Result<()> {
    run(dir, &["branch", "-m", "--", safe_name(old_name)?, safe_name(new_name)?], None).await.map(drop)
}

pub async fn create_tag(dir: &str, name: &str, at: &str, message: Option<&str>) -> Result<()> {
    match message.filter(|m| !m.trim().is_empty()) {
        Some(m) => run(dir, &["tag", "-a", "-F", "-", "--", safe_name(name)?, safe_name(at)?], Some(m.as_bytes()))
            .await
            .map(drop),
        None => run(dir, &["tag", "--", safe_name(name)?, safe_name(at)?], None).await.map(drop),
    }
}

pub async fn delete_tag(dir: &str, name: &str) -> Result<()> {
    run(dir, &["tag", "-d", "--", safe_name(name)?], None).await.map(drop)
}

pub async fn stash_save(dir: &str, message: Option<&str>) -> Result<()> {
    let mut args = vec!["stash", "push", "-u", "-q"];
    if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
        args.extend(["-m", m]);
    }
    run(dir, &args, None).await.map(drop)
}

pub async fn stash_apply(dir: &str, index: i64, pop: bool) -> Result<()> {
    run(dir, &["stash", if pop { "pop" } else { "apply" }, "-q", &format!("stash@{{{index}}}")], None)
        .await
        .map(drop)
}

pub async fn stash_drop(dir: &str, index: i64) -> Result<()> {
    run(dir, &["stash", "drop", "-q", &format!("stash@{{{index}}}")], None).await.map(drop)
}

pub async fn merge(dir: &str, branch: &str) -> Result<&'static str> {
    let r = try_run(dir, &["merge", "--no-edit", safe_name(branch)?], None).await?;
    if !r.ok {
        if state_of(dir).await? == Some("merge") {
            return Ok("conflicts");
        }
        return err(r.failure());
    }
    let t = r.text();
    Ok(if t.to_lowercase().contains("already up to date") {
        "up-to-date"
    } else if t.contains("Fast-forward") {
        "fast-forward"
    } else {
        "merged"
    })
}

async fn has_unmerged(dir: &str) -> Result<bool> {
    let t = run(dir, &["status", "--porcelain", "-uno"], None).await?.text();
    Ok(t.lines().any(|l| matches!(l.get(..3), Some("UU " | "AA " | "DD " | "AU " | "UA " | "DU " | "UD "))))
}

async fn autostash_index(dir: &str) -> Result<Option<usize>> {
    let list = try_run(dir, &["stash", "list", "--format=%gs"], None).await?.text();
    Ok(list.split('\n').position(|s| s.trim().ends_with("autostash")))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct RebaseResult {
    pub result: &'static str,
    pub before: String,
}

pub async fn rebase(dir: &str, onto: &str) -> Result<RebaseResult> {
    let before = text(dir, &["rev-parse", "HEAD"]).await?;
    let r = try_run(dir, &["-c", "core.editor=true", "rebase", "--autostash", "--", safe_name(onto)?], None).await?;
    if !r.ok {
        if state_of(dir).await? == Some("rebase") {
            return Ok(RebaseResult { result: "conflicts", before });
        }
        return err(r.failure());
    }
    Ok(RebaseResult {
        result: if has_unmerged(dir).await? { "stash-conflicts" } else { "done" },
        before,
    })
}

pub async fn undo_rebase(dir: &str, before: &str) -> Result<&'static str> {
    let last = text(dir, &["reflog", "-1", "--format=%gs", "HEAD"]).await?;
    let orig = text_or_empty(dir, &["rev-parse", "-q", "--verify", "ORIG_HEAD"]).await?;
    let want = text(dir, &["rev-parse", "-q", "--verify", &format!("{}^{{commit}}", safe_name(before)?)]).await?;
    if !last.starts_with("rebase") || orig != want {
        return err("The branch changed after the rebase, so it cannot be undone safely here.");
    }
    let unmerged = has_unmerged(dir).await?;
    if unmerged {
        run(dir, &["reset", "-q"], None).await?;
    }
    let dirty = !text(dir, &["status", "--porcelain", "-uno"]).await?.is_empty();
    if dirty {
        run(
            dir,
            &["stash", "push", "-q", "-m", if unmerged { "Backup before undoing the rebase" } else { "autostash" }],
            None,
        )
        .await?;
    }
    let reset = try_run(dir, &["reset", "-q", "--keep", &want], None).await?;
    if !reset.ok {
        if dirty {
            try_run(dir, &["stash", "pop", "-q"], None).await?;
        }
        return err(reset.failure());
    }
    let Some(i) = autostash_index(dir).await? else { return Ok("done") };
    let pop = try_run(dir, &["stash", "pop", "-q", &format!("stash@{{{i}}}")], None).await?;
    Ok(if pop.ok { "done" } else { "stash-conflicts" })
}

pub async fn drop_autostash(dir: &str) -> Result<()> {
    if let Some(i) = autostash_index(dir).await? {
        run(dir, &["stash", "drop", "-q", &format!("stash@{{{i}}}")], None).await?;
    }
    Ok(())
}

async fn apply_commit(dir: &str, args: &[&str], state: &str) -> Result<&'static str> {
    let r = try_run(dir, args, None).await?;
    if !r.ok {
        if state_of(dir).await? == Some(state) {
            return Ok("conflicts");
        }
        return err(r.failure());
    }
    Ok("done")
}

pub async fn cherry_pick(dir: &str, oid: &str) -> Result<&'static str> {
    apply_commit(dir, &["cherry-pick", safe_name(oid)?], "cherry-pick").await
}

pub async fn revert(dir: &str, oid: &str) -> Result<&'static str> {
    apply_commit(dir, &["revert", "--no-edit", safe_name(oid)?], "revert").await
}

pub async fn reset(dir: &str, oid: &str, mode: &str) -> Result<()> {
    if !["soft", "mixed", "hard"].contains(&mode) {
        return err("Invalid reset mode");
    }
    run(dir, &["reset", "-q", &format!("--{mode}"), safe_name(oid)?], None).await.map(drop)
}

pub async fn abort(dir: &str) -> Result<()> {
    if let Some(state) = state_of(dir).await? {
        run(dir, &[state, "--abort"], None).await?;
    }
    Ok(())
}

pub async fn continue_op(dir: &str) -> Result<()> {
    match state_of(dir).await? {
        None => Ok(()),
        Some("merge") => run(dir, &["-c", "core.editor=true", "commit", "-q", "--no-edit"], None).await.map(drop),
        Some(state) => run(dir, &["-c", "core.editor=true", state, "--continue"], None).await.map(drop),
    }
}

pub async fn fetch_all(dir: &str) -> Result<()> {
    run(dir, &["fetch", "--all", "--prune"], None).await.map(drop)
}

pub async fn pull(dir: &str, mode: &str) -> Result<()> {
    let flags: &[&str] = match mode {
        "rebase" => &["--rebase", "--autostash"],
        "ff-only" => &["--ff-only"],
        _ => &["--no-rebase"],
    };
    let mut args = vec!["pull"];
    args.extend(flags);
    run(dir, &args, None).await.map(drop)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(untagged)]
pub enum PushResult {
    Pushed { result: &'static str },
    Rejected { result: &'static str, ahead: u64, behind: u64, theirs: String },
}

pub async fn push(dir: &str, lease: Option<&str>) -> Result<PushResult> {
    if let Some(l) = lease {
        if !(40..=64).contains(&l.len()) || !l.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
            return err("Bad lease");
        }
    }
    let branch = text(dir, &["symbolic-ref", "-q", "--short", "HEAD"]).await?;
    let upstream = text_or_empty(dir, &["rev-parse", "-q", "--abbrev-ref", "@{u}"]).await?;
    let merge_ref = if upstream.is_empty() {
        format!("refs/heads/{branch}")
    } else {
        text(dir, &["config", "--get", &format!("branch.{branch}.merge")]).await?
    };
    let force = lease.map(|l| format!("--force-with-lease={merge_ref}:{l}"));
    let mut args: Vec<String> = vec!["push".into()];
    args.extend(force.iter().cloned());
    let mut remote = upstream.split('/').next().unwrap_or("").to_string();
    let mut target = "@{u}".to_string();
    if upstream.is_empty() {
        let remotes: Vec<String> = text(dir, &["remote"]).await?.split('\n').filter(|s| !s.is_empty()).map(String::from).collect();
        remote = if remotes.iter().any(|r| r == "origin") {
            "origin".into()
        } else {
            remotes.first().cloned().unwrap_or_default()
        };
        if remote.is_empty() {
            return err("This repository has no remote to push to");
        }
        args.extend(["-u".into(), "--".into(), remote.clone(), branch.clone()]);
        target = format!("{remote}/{branch}");
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let r = try_run(dir, &argv, None).await?;
    if r.ok {
        return Ok(PushResult::Pushed { result: "pushed" });
    }
    let t = r.failure();
    if force.is_some() || !(t.contains("[rejected]") || t.contains("non-fast-forward") || t.contains("fetch first")) {
        return err(t);
    }
    try_run(dir, &["fetch", "-q", "--", &remote], None).await?;
    let (ahead, behind) = counts(&text_or_empty(dir, &["rev-list", "--left-right", "--count", &format!("HEAD...{target}")]).await?);
    let theirs = text_or_empty(dir, &["rev-parse", "-q", "--verify", &format!("{target}^{{commit}}")]).await?;
    Ok(PushResult::Rejected {
        result: "rejected",
        ahead,
        behind,
        theirs,
    })
}
