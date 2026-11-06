//! Keeps the computer from going to sleep on its own while an AI agent works.
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// The system's own way to keep it awake; each one also ends when the helper does, even if it crashes.
fn command(pid: u32) -> Command {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("caffeinate");
        c.args(["-i", "-w", &pid.to_string()]);
        c
    } else if cfg!(windows) {
        let keep = format!("Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(''kernel32.dll'')] public static extern uint SetThreadExecutionState(uint f);'; while (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ [void][W.P]::SetThreadExecutionState(1); Start-Sleep 20 }}");
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", &keep]);
        c
    } else {
        let mut c = Command::new("systemd-inhibit");
        c.args([
            "--what=idle",
            "--who=Ramulus",
            "--why=An AI agent is working",
            "sh",
            "-c",
            &format!("while kill -0 {pid} 2>/dev/null; do sleep 10; done"),
        ]);
        c
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::NO_WINDOW);
    }
    cmd
}

/// Keeps the computer awake while set to true. A tool that is missing or ends by itself is not tried again.
#[derive(Default)]
pub struct Wake {
    /// the running tool, and whether it failed once
    state: Mutex<(Option<Child>, bool)>,
    /// the person turned the Keep awake switch off
    paused: AtomicBool,
}

impl Wake {
    pub fn set(&self, on: bool) {
        let on = on && !self.paused.load(Ordering::Relaxed);
        let mut st = self.state.lock().unwrap();
        let (child, broken) = &mut *st;
        if child.as_mut().is_some_and(|c| !matches!(c.try_wait(), Ok(None))) {
            *child = None;
            *broken = true;
        }
        if on && child.is_none() && !*broken {
            match command(std::process::id()).spawn() {
                Ok(c) => *child = Some(c),
                Err(_) => *broken = true,
            }
        } else if !on {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }

    /// The Keep awake switch: off lets the computer sleep at once, even while an agent works.
    pub fn pause(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
        if paused {
            self.set(false);
        }
    }
}
