import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, findBin } from './ai.js'

const WIN = process.platform === 'win32'
const KEEP = 200000
const TITLE_MAX = 120
const SAVE_EVERY = 2000
// a helper saving more recently than this still runs, and keeps the saved tabs to itself
const OWNER_FRESH = 6000
// printed between a restored tab's old output and the program started again below it
const RESTORED = '\x1b[?47l\x1b[!p\r\n\x1b[2m─── new session ───\x1b[0m\r\n'

let ptyModule
const loadPty = () => (ptyModule ??= import('@lydell/node-pty').then((m) => m.default ?? m, () => null))

export function trimTail(buf, keep) {
  if (buf.length <= keep) return buf
  const cut = buf.indexOf('\n', buf.length - keep)
  return buf.slice(cut < 0 ? buf.length - keep : cut + 1)
}

/** The last complete window title (OSC 0 or 2) in `s`, the way Claude Code names its conversation. */
export function lastTitle(s) {
  let last
  for (const m of s.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) last = m[1]
  return last
}

export const cleanTitle = (t) => [...t.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()].slice(0, TITLE_MAX).join('') || undefined

const size = (n, min, max, fallback) => (Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback)

const MAX_PER_REPO = 8

const validUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)

// a session id goes to the agent as an argument, through cmd.exe on Windows
export const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/
// how the other agents go back to a conversation; Claude Code tabs carry theirs as the tab's uuid
const RESUME = { codex: (id) => ['resume', id], opencode: (id) => ['--session', id] }

const writeAtomic = (file, text) => {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

// Claude Code saves a conversation under its id once the first message is sent.
const claudeHas = (env, uuid) => {
  const base = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  try {
    return readdirSync(base).some((d) => existsSync(join(base, d, `${uuid}.jsonl`)))
  } catch {
    return false
  }
}

/** Terminal tabs; with a `dir`, they are saved there and the ones the last run saved come back. */
export function createTerminals(dir) {
  const sessions = new Map()
  let seq = 0
  const key = (repo, id) => `${repo}\n${id}`
  const send = (s, event, data) => {
    for (const res of s.clients) res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
  }
  // The agent keeps the conversation itself and prints it again on resume.
  const resumes = (s) => s.agent === 'claude' || !!s.resume
  const session = (fields) => ({ proc: null, buf: '', exit: null, title: undefined, unsaved: true, clients: new Set(), ...fields })

  const inUse = () => {
    try {
      return Date.now() - statSync(join(dir, 'owner')).mtimeMs < OWNER_FRESH
    } catch {
      return false
    }
  }
  let store = !!dir && !inUse()
  let index = ''
  const save = (output) => {
    if (!store) return
    const list = [...sessions].sort(([, a], [, b]) => a.seq - b.seq)
    const saved = list.map(([k, s]) => {
      const at = k.lastIndexOf('\n')
      return { repo: k.slice(0, at), id: k.slice(at + 1), kind: s.kind, agent: s.agent, title: s.title, uuid: s.uuid, resume: s.resume }
    })
    const text = JSON.stringify(saved)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'owner'), String(process.pid))
      if (text !== index) {
        writeAtomic(join(dir, 'index.json'), text)
        index = text
      }
      if (!output) return
      for (const [, s] of list) {
        if (resumes(s) || !s.unsaved) continue
        s.unsaved = false
        writeAtomic(join(dir, `${s.uuid}.log`), s.buf)
      }
    } catch {}
  }
  const forget = (uuid) => store && rmSync(join(dir, `${uuid}.log`), { force: true })

  if (store) {
    try {
      index = readFileSync(join(dir, 'index.json'), 'utf8')
    } catch {}
    let saved = []
    try {
      saved = [JSON.parse(index)].flat()
    } catch {}
    for (const e of saved) {
      if (!e || typeof e.repo !== 'string' || typeof e.id !== 'string' || !validUuid(e.uuid)) continue
      if (!existsSync(e.repo) || !statSync(e.repo).isDirectory() || sessions.has(key(e.repo, e.id))) continue
      let buf = ''
      try {
        buf = readFileSync(join(dir, `${e.uuid}.log`), 'utf8')
      } catch {}
      const agent = AGENTS.some((a) => a.id === e.agent) ? e.agent : undefined
      const title = typeof e.title === 'string' ? cleanTitle(e.title) : undefined
      const resume = RESUME[agent] && SESSION_ID.test(e.resume ?? '') ? e.resume : undefined
      sessions.set(key(e.repo, e.id), session({ seq: seq++, kind: e.kind === 'shell' ? 'shell' : 'agent', agent, uuid: e.uuid, resume, buf: trimTail(buf, KEEP), title, exit: { code: null }, unsaved: false }))
    }
    const kept = new Set([...sessions.values()].map((s) => `${s.uuid}.log`))
    try {
      for (const f of readdirSync(dir)) if (f.endsWith('.log') && !kept.has(f)) rmSync(join(dir, f), { force: true })
    } catch {}
    save(false)
    setInterval(() => save(true), SAVE_EVERY).unref()
  }

  // closes a tab for good: its program ends and its saved output goes
  const stopKey = (k) => {
    const s = sessions.get(k)
    if (!s) return
    sessions.delete(k)
    s.proc?.kill()
    forget(s.uuid)
  }

  const command = (kind, agentId, extra, env) => {
    if (kind === 'shell') return WIN ? [env.ComSpec || 'cmd.exe', []] : [env.SHELL || '/bin/sh', []]
    const agent = AGENTS.find((a) => a.id === agentId)
    const bin = agent && findBin(agent.bin, env)
    if (!bin) throw new Error('That AI agent is not installed')
    return WIN ? [env.ComSpec || 'cmd.exe', ['/d', '/c', bin, ...extra]] : [bin, extra]
  }

  return {
    /** `resume` names an agent conversation for a new tab to go back to instead of starting one. */
    async start(repo, id, kind, agentId, cols, rows, env = process.env, resume) {
      const c = size(cols, 20, 500, 80)
      const r = size(rows, 5, 200, 24)
      const k = key(repo, id)
      const old = sessions.get(k)
      if (old && !old.exit) {
        old.proc.resize(c, Math.max(5, r - 1))
        old.proc.resize(c, r)
        return { agent: old.agent, fresh: false }
      }
      if (!old && [...sessions.keys()].filter((x) => x.startsWith(`${repo}\n`)).length >= MAX_PER_REPO) throw new Error('Close a terminal tab before opening another')
      const claude = kind !== 'shell' && agentId === 'claude'
      if (!old && resume !== undefined && !(claude ? validUuid(resume) : RESUME[agentId] && kind !== 'shell' && SESSION_ID.test(resume))) throw new Error('That conversation cannot be resumed')
      // an ended or restored tab starts again as itself, below what it printed before
      const s = old
        ? session({ seq: old.seq, kind: old.kind, agent: old.agent, uuid: old.uuid, resume: old.resume, title: old.title, buf: resumes(old) || !old.buf ? '' : old.buf + RESTORED })
        : session({ seq: seq++, kind: kind === 'shell' ? 'shell' : 'agent', agent: kind === 'shell' ? undefined : agentId, uuid: claude && resume ? resume : randomUUID(), resume: claude ? undefined : resume })
      const extra = s.agent === 'claude' ? [claudeHas(env, s.uuid) ? '--resume' : '--session-id', s.uuid] : s.resume ? RESUME[s.agent](s.resume) : []
      const [file, args] = command(s.kind, s.agent, extra, env)
      const pty = await loadPty()
      if (!pty) throw new Error('The terminal is not available on this system')
      const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: c, rows: r, cwd: repo, env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
      s.proc = proc
      s.started = Date.now()
      sessions.set(k, s)
      save(false)
      proc.onData((d) => {
        // a title can arrive split across reads, so look a little before this one too
        const title = lastTitle((s.buf + d).slice(-(d.length + 256)))
        if (title !== undefined) s.title = cleanTitle(title)
        s.buf = trimTail(s.buf + d, KEEP)
        s.unsaved = true
        send(s, '', d)
      })
      proc.onExit(({ exitCode }) => {
        s.exit = { code: exitCode }
        send(s, 'exit', exitCode)
      })
      return { agent: s.agent, fresh: true }
    },
    list(repo) {
      const prefix = key(repo, '')
      return [...sessions]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([, a], [, b]) => a.seq - b.seq)
        .map(([k, s]) => ({ id: k.slice(prefix.length), kind: s.kind, agent: s.agent, title: s.title }))
    },
    /**
     * The agent sessions this folder's tabs hold: Claude Code tabs by id, resumed tabs by what they resumed, and for
     * the other agents, whatever changed since a running new tab of theirs started, since that tab's id is not known.
     */
    held(repo) {
      const ids = new Set()
      const since = new Map()
      for (const [k, s] of sessions) {
        if (!k.startsWith(key(repo, ''))) continue
        if (s.agent === 'claude') ids.add(s.uuid)
        else if (s.resume) ids.add(s.resume)
        else if (s.agent && s.proc && !s.exit) since.set(s.agent, Math.min(since.get(s.agent) ?? Infinity, s.started))
      }
      return { ids, since }
    },
    attach(repo, id, res) {
      const s = sessions.get(key(repo, id))
      if (!s) {
        res.write('event: exit\ndata: null\n\n')
        return () => {}
      }
      if (s.buf) res.write(`data: ${JSON.stringify(s.buf)}\n\n`)
      if (s.exit) {
        res.write(`event: exit\ndata: ${JSON.stringify(s.exit.code)}\n\n`)
        return () => {}
      }
      s.clients.add(res)
      return () => s.clients.delete(res)
    },
    write(repo, id, data) {
      sessions.get(key(repo, id))?.proc?.write(String(data))
    },
    resize(repo, id, cols, rows) {
      sessions.get(key(repo, id))?.proc?.resize(size(cols, 20, 500, 80), size(rows, 5, 200, 24))
    },
    stop(repo, id) {
      if (id !== undefined) stopKey(key(repo, id))
      else for (const k of [...sessions.keys()]) if (k.startsWith(`${repo}\n`)) stopKey(k)
      save(false)
    },
    // saves every tab for the next run, then ends their programs: the helper shutting down, not tabs closing
    stopAll() {
      save(true)
      if (store) rmSync(join(dir, 'owner'), { force: true })
      store = false
      for (const s of sessions.values()) s.proc?.kill()
    },
  }
}
