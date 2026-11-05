pub mod ai;
pub mod git;
pub mod prs;
pub mod server;
pub mod sessions;
pub mod term;
pub mod wake;

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error(e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(Error(msg.into()))
}

/// The environment the helper tools run with, as name/value pairs.
pub type Env = HashMap<String, String>;

pub fn env() -> Env {
    std::env::vars().collect()
}

/// Reads a variable the way Node does: case-insensitively on Windows.
pub fn var<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    if cfg!(windows) {
        env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
    } else {
        env.get(key).map(String::as_str)
    }
}

pub fn home() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    PathBuf::from(std::env::var_os(key).unwrap_or_default())
}

/// Lexical path resolution like Node's path.resolve: joins onto base and folds `.` and `..` without touching the disk.
pub fn resolve(base: &Path, path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in base.join(path).components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}

#[cfg(windows)]
pub const NO_WINDOW: u32 = 0x0800_0000;
