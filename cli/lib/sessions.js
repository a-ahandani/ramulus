import { execFile } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { findBin } from './ai.js'
import { SESSION_ID, cleanTitle } from './term.js'

const WIN = process.platform === 'win32'
const MAX = 50
const CHUNK = 65536
// Codex writes the first prompt after its instructions, which can be a few hundred KB into the file
const HEAD_MAX = 1 << 20

/** What each session file held when it was last read, by path, with the size and time it had then. */
const cache = new Map()

function readAt(file, pos, len) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    return buf.subarray(0, readSync(fd, buf, 0, len, pos)).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

// whole JSON lines only: a chunk that starts or ends inside a line drops that piece
function lines(text, cutStart, cutEnd) {
  const all = text.split('\n')
  if (cutStart) all.shift()
  if (cutEnd) all.pop()
  return all.flatMap((l) => {
    try {
      const o = JSON.parse(l)
      return o && typeof o === 'object' ? [o] : []
    } catch {
      return []
    }
  })
}

const oneLine = (s) => (typeof s === 'string' ? cleanTitle(s.split(/[\t\n\r ]+/).filter(Boolean).join(' ')) : undefined)

// the files that exist, with their size and last change, newest first
function newest(files) {
  return files
    .flatMap((file) => {
      try {
        const st = statSync(file)
        return st.isFile() ? [{ file, size: st.size, time: Math.floor(st.mtimeMs) }] : []
      } catch {
        return []
      }
    })
    // the same order in both helpers when two files changed in the same millisecond
    .sort((a, b) => b.time - a.time || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

function cached(f, read) {
  const hit = cache.get(f.file)
  if (hit && hit.size === f.size && hit.time === f.time) return hit.info
  let info
  try {
    info = read(f)
  } catch {
    info = null
  }
  cache.set(f.file, { size: f.size, time: f.time, info })
  return info
}

// Git names a Windows folder C:/a/b, and the agents C:\a\b; Windows folder names ignore case.
const same = (a, b) => typeof a === 'string' && (WIN ? a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase() : a === b)

const userText = (o) => {
  if (o.type !== 'user' || o.isMeta || o.message?.role !== 'user') return undefined
  const c = o.message.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b?.type === 'text')?.text : undefined
  return typeof text === 'string' && !text.startsWith('<') ? text : undefined
}

// Claude Code notes each running conversation in sessions/<pid>.json, which a crash leaves behind, so the process must still run.
function claudeRunning(base) {
  const live = new Set()
  // shortcut: Windows has no process check both helpers share, so conversations running outside Ramulus show there; add one if that bites
  if (WIN) return live
  let names = []
  try {
    names = readdirSync(join(base, 'sessions'))
  } catch {}
  for (const n of names) {
    const pid = Number(/^(\d+)\.json$/.exec(n)?.[1])
    if (!pid) continue
    try {
      process.kill(pid, 0)
    } catch (e) {
      if (e.code !== 'EPERM') continue
    }
    try {
      const id = JSON.parse(readFileSync(join(base, 'sessions', n), 'utf8'))?.sessionId
      if (typeof id === 'string') live.add(id)
    } catch {}
  }
  return live
}

// Claude Code keeps a folder's conversations in one directory named after the folder, and names each one as it goes.
function claude(repo, env) {
  const base = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const dir = join(base, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'))
  const running = claudeRunning(base)
  let names = []
  try {
    names = readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n))
  } catch {}
  const out = []
  for (const f of newest(names.map((n) => join(dir, n)))) {
    const info = cached(f, ({ file, size }) => {
      const head = lines(readAt(file, 0, CHUNK), false, size > CHUNK)
      const tail = size > CHUNK ? lines(readAt(file, size - CHUNK, CHUNK), true, false) : []
      const cwd = head.find((o) => typeof o.cwd === 'string')?.cwd
      const titled = [...head, ...tail].findLast((o) => o.type === 'ai-title' && typeof o.aiTitle === 'string')
      return { cwd, title: oneLine(titled?.aiTitle) ?? oneLine(head.map(userText).find(Boolean)) }
    })
    // two folders can share a directory name, so the folder the conversation names decides
    if (same(info?.cwd, repo) && info.title && !running.has(basename(f.file, '.jsonl'))) out.push({ agent: 'claude', id: basename(f.file, '.jsonl'), title: info.title, time: f.time })
    if (out.length >= MAX) break
  }
  return out
}

function codexInfo({ file, size }) {
  let head = lines(readAt(file, 0, CHUNK), false, size > CHUNK)
  const meta = head[0]?.type === 'session_meta' ? head[0].payload : undefined
  if (!meta || typeof meta.id !== 'string' || typeof meta.cwd !== 'string') return null
  // sessions run by other programs (exec) and subagents (an object) are not conversations to go back to
  if (typeof meta.source !== 'string' || meta.source === 'exec') return null
  const prompt = (o) => (o.type === 'event_msg' && o.payload?.type === 'user_message' && typeof o.payload.message === 'string' ? o.payload.message : undefined)
  if (!head.some(prompt) && size > CHUNK) head = lines(readAt(file, 0, HEAD_MAX), false, size > HEAD_MAX)
  // the VS Code extension puts the open files before what was asked
  const asked = head.map(prompt).find(Boolean)?.split('## My request for Codex:').pop()
  return { id: meta.id, cwd: meta.cwd, prompt: oneLine(asked) }
}

// Codex keeps every conversation by date and names some of them in an index beside them.
function codex(repo, env) {
  const base = env.CODEX_HOME || join(homedir(), '.codex')
  const names = new Map()
  try {
    for (const o of lines(readFileSync(join(base, 'session_index.jsonl'), 'utf8'))) if (typeof o.id === 'string') names.set(o.id, o.thread_name)
  } catch {}
  const files = []
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {}
    for (const e of entries) {
      if (depth < 3 && e.isDirectory()) walk(join(dir, e.name), depth + 1)
      else if (depth === 3 && e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(join(dir, e.name))
    }
  }
  walk(join(base, 'sessions'), 0)
  const out = []
  for (const f of newest(files)) {
    const info = cached(f, codexInfo)
    if (!info || !same(info.cwd, repo)) continue
    const title = oneLine(names.get(info.id)) ?? info.prompt
    if (title) out.push({ agent: 'codex', id: info.id, title, time: f.time })
    if (out.length >= MAX) break
  }
  return out
}

// opencode keeps its conversations in a database, so it is asked for them.
function opencode(repo, env) {
  const bin = findBin('opencode', env)
  if (!bin) return Promise.resolve([])
  return new Promise((resolve) =>
    execFile(WIN ? `"${bin}"` : bin, ['session', 'list', '--format', 'json'], { cwd: repo, env, shell: WIN, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => {
      let list = []
      try {
        list = e ? [] : [JSON.parse(stdout)].flat()
      } catch {}
      resolve(
        list.flatMap((s) => {
          const title = oneLine(s?.title)
          if (!same(s?.directory, repo) || typeof s.id !== 'string' || !title) return []
          return [{ agent: 'opencode', id: s.id, title, time: Math.floor(Number(s.updated)) || 0 }]
        }),
      )
    }),
  )
}

/**
 * The agent conversations held in `repo` that no tab has open, newest first: the ones to go back to.
 * `held` says which sessions the folder's tabs have open (see the terminals' `held`).
 */
export async function agentSessions(repo, held, env = process.env) {
  const on = (bin) => !!findBin(bin, env)
  const asked = opencode(repo, env)
  const all = [...(on('claude') ? claude(repo, env) : []), ...(on('codex') ? codex(repo, env) : []), ...(await asked)]
  return all
    .filter((s) => SESSION_ID.test(s.id) && !held.ids.has(s.id) && !(held.since.has(s.agent) && s.time >= held.since.get(s.agent)))
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX)
}
