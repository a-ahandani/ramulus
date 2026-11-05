import { spawn } from 'node:child_process'

// The system's own way to keep it from sleeping on its own; each one also ends when the helper does, even if it crashes.
function command(pid) {
  if (process.platform === 'darwin') return ['caffeinate', ['-i', '-w', String(pid)]]
  if (process.platform === 'win32') {
    const keep = `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(''kernel32.dll'')] public static extern uint SetThreadExecutionState(uint f);'; while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [void][W.P]::SetThreadExecutionState(1); Start-Sleep 20 }`
    return ['powershell', ['-NoProfile', '-NonInteractive', '-Command', keep]]
  }
  return ['systemd-inhibit', ['--what=idle', '--who=Ramulus', '--why=An AI agent is working', 'sh', '-c', `while kill -0 ${pid} 2>/dev/null; do sleep 10; done`]]
}

/** Keeps the computer awake while called with true. A tool that is missing or ends by itself is not tried again. */
export function createWake() {
  let proc
  let broken = false
  return (on) => {
    if (on && !proc && !broken) {
      const [file, args] = command(process.pid)
      const p = spawn(file, args, { stdio: 'ignore', windowsHide: true })
      proc = p
      const gone = () => {
        if (proc !== p) return
        proc = undefined
        broken = true
      }
      p.on('error', gone)
      p.on('exit', gone)
    } else if (!on && proc) {
      const p = proc
      proc = undefined
      p.kill()
    }
  }
}
