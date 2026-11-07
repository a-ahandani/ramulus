import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import * as ai from './ai.js'
import * as git from './git.js'
import { changePullRequest, ciRuns, mergePullRequest, prConversation, pullRequest, pullRequests } from './prs.js'
import { agentSessions } from './sessions.js'
import { createTerminals } from './term.js'
import { WebSocketServer } from 'ws'

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

const termId = (id) => {
  if (id === undefined || id === null) return 'main'
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id)) throw new Error('Invalid terminal id')
  return id
}

const OPS = {
  load: (dir, b) => git.load(dir, b.limit),
  init: async (dir) => void (await git.run(dir, ['init'])),
  files: (dir) => git.files(dir),
  prs: (dir) => pullRequests(dir),
  ciRuns: (dir) => ciRuns(dir),
  prMerge: (dir, b) => mergePullRequest(dir, b.number, b.method),
  prView: (dir, b) => pullRequest(dir, b.number),
  prConversation: (dir, b) => prConversation(dir, b.number),
  prChange: (dir, b) => changePullRequest(dir, b.number, b.action),
  status: (dir) => git.status(dir),
  commitFiles: (dir, b) => git.commitFiles(dir, b.oid),
  fileVersions: (dir, b) => git.fileVersions(dir, b.area, b.path),
  writeIndex: (dir, b) => git.writeIndex(dir, b.path, b.content, b.expected),
  writeWorkdir: (dir, b) => git.writeWorkdir(dir, b.path, b.content, b.expected),
  openPath: (dir, b) => git.openPath(dir, b.path),
  revealPath: (dir, b) => git.revealPath(dir, b.path),
  stage: (dir, b) => git.stage(dir, b.paths),
  unstage: (dir, b) => git.unstage(dir, b.paths),
  discard: (dir, b) => git.discard(dir, b.files),
  commit: (dir, b) => git.commit(dir, b.message, b.amend),
  checkoutBranch: (dir, b) => git.checkoutBranch(dir, b.name),
  checkoutRemote: (dir, b) => git.checkoutRemote(dir, b.name),
  checkoutCommit: (dir, b) => git.checkoutCommit(dir, b.oid),
  createBranch: (dir, b) => git.createBranch(dir, b.name, b.at, b.checkout),
  deleteBranch: (dir, b) => git.deleteBranch(dir, b.name),
  deleteRemoteBranch: (dir, b) => git.deleteRemoteBranch(dir, b.name),
  renameBranch: (dir, b) => git.renameBranch(dir, b.oldName, b.newName),
  createTag: (dir, b) => git.createTag(dir, b.name, b.at, b.message),
  deleteTag: (dir, b) => git.deleteTag(dir, b.name),
  stashSave: (dir, b) => git.stashSave(dir, b.message),
  stashApply: (dir, b) => git.stashApply(dir, b.index, b.pop),
  stashDrop: (dir, b) => git.stashDrop(dir, b.index),
  merge: (dir, b) => git.merge(dir, b.branch),
  rebase: (dir, b) => git.rebase(dir, b.onto),
  undoRebase: (dir, b) => git.undoRebase(dir, b.before),
  dropAutostash: (dir) => git.dropAutostash(dir),
  cherryPick: (dir, b) => git.cherryPick(dir, b.oid),
  revert: (dir, b) => git.revert(dir, b.oid),
  reset: (dir, b) => git.reset(dir, b.oid, b.mode),
  abort: (dir) => git.abort(dir),
  continue: (dir) => git.continueOp(dir),
  fetchAll: (dir) => git.fetchAll(dir),
  pull: (dir, b) => git.pull(dir, b.mode),
  push: (dir, b) => git.push(dir, b.lease),
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data ?? null))
}

const STATE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ramulus', 'recent.json')

function watchRepo(dir) {
  const clients = new Set()
  let timer
  let watcher
  try {
    watcher = watch(dir, { recursive: true }, (_, file) => {
      const f = (file ?? '').toString().replaceAll('\\', '/')
      if (f.includes('.git/objects') || f.endsWith('.lock') || f.includes('node_modules')) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        for (const res of clients) res.write('data: changed\n\n')
      }, 400)
    })
  } catch {
    watcher = undefined
  }
  return { clients, close: () => (clearTimeout(timer), watcher?.close()) }
}

export function createServer({ dir, root = dir, uiDir, token, stateFile = STATE }) {
  const known = new Set(dir ? [dir] : [])
  const watchers = new Map()
  const pinFile = join(dirname(stateFile), 'pinned.json')
  const prefsFile = join(dirname(stateFile), 'prefs.json')
  const readList = (file) => readFile(file, 'utf8').then((t) => [JSON.parse(t)].flat().filter((d) => typeof d === 'string'), () => [])
  const readRecent = () => readList(stateFile)
  const remember = async (repo) => {
    const list = [repo, ...(await readRecent()).filter((d) => d !== repo)].slice(0, 12)
    await mkdir(dirname(stateFile), { recursive: true })
    await writeFile(stateFile, JSON.stringify(list))
  }
  if (dir) remember(dir).catch(() => {})
  const info = (repo) => ({ dir: repo, name: basename(repo) })
  const aiFile = join(dirname(stateFile), 'ai.json')
  const readAi = () => readFile(aiFile, 'utf8').then((t) => ai.cleanSettings(JSON.parse(t)), () => ai.cleanSettings({}))
  const needAi = async () => {
    if ((await readAi()).enabled !== true) throw new Error('AI help is turned off')
  }
  const terms = createTerminals(join(dirname(stateFile), 'terms'))
  const readPrefs = () => readFile(prefsFile, 'utf8').then(JSON.parse, () => ({}))
  readPrefs().then((p) => terms.allowWake(p?.keepAwake), () => {})
  const ops = {
    ...OPS,
    aiContext: (repo, b) => git.aiContext(repo, b.task, { at: b.at }),
    termStart: async (repo, b) => {
      const kind = b.kind === 'shell' ? 'shell' : 'agent'
      if (kind === 'agent') await needAi()
      return terms.start(repo, termId(b.id), kind, String(b.agent ?? ''), b.cols, b.rows, process.env, b.resume ? String(b.resume) : undefined)
    },
    termList: (repo) => terms.list(repo),
    agentSessions: (repo) => agentSessions(repo, terms.held(repo)),
    termStop: (repo, b) => terms.stop(repo, b.all ? undefined : termId(b.id)),
    aiAsk: async (repo, b, res) => {
      await needAi()
      const stop = new AbortController()
      res.on('close', () => stop.abort())
      return ai.ask(String(b.agent), String(b.prompt ?? ''), { signal: stop.signal })
    },
  }
  const SHELL = {
    repos: async () => ({ current: dir ? info(dir) : null, recent: (await readRecent()).filter((d) => existsSync(d)).map(info) }),
    pins: async () => (await readList(pinFile)).filter((d) => existsSync(d)).map(info),
    setPins: async (b) => {
      const dirs = [b.dirs].flat().filter((d) => typeof d === 'string').slice(0, 50)
      await mkdir(dirname(pinFile), { recursive: true })
      await writeFile(pinFile, JSON.stringify(dirs))
    },
    prefs: readPrefs,
    setPrefs: async (b) => {
      const text = JSON.stringify(b.prefs && typeof b.prefs === 'object' ? b.prefs : {})
      if (text.length > 20000) throw new Error('Preferences are too large')
      await mkdir(dirname(prefsFile), { recursive: true })
      await writeFile(prefsFile, text)
      terms.allowWake(b.prefs?.keepAwake)
    },
    findRepos: async () => {
      const at = dir ?? root
      return { root: at, inside: !!dir, repos: at === homedir() ? [] : (await git.findRepos(at)).map(info) }
    },
    pickFolder: () => git.pickFolder(),
    ai: async () => ({ agents: ai.detect(), settings: await readAi() }),
    setAi: async (b) => {
      await mkdir(dirname(aiFile), { recursive: true })
      await writeFile(aiFile, JSON.stringify(ai.cleanSettings(b.settings)))
    },
    openRepo: async (b) => {
      const path = resolve(dir ?? root, String(b.path ?? '').trim().replace(/^~(?=$|[/\\])/, homedir()))
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('That folder does not exist')
      // a folder without git opens too, for its terminals and to start a repository in it
      const top = await git.toplevel(path).catch((e) => {
        if (/not a git repository/.test(e?.message ?? '')) return path
        throw e
      })
      known.add(top)
      await remember(top).catch(() => {})
      return info(top)
    },
  }

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host ?? ''
    if (!LOCAL_HOST.test(host)) {
      res.writeHead(403).end('forbidden host')
      return
    }
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/events') {
      const repo = url.searchParams.get('repo') || dir
      if (url.searchParams.get('token') !== token || !known.has(repo)) {
        res.writeHead(401).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': connected\n\n')
      let w = watchers.get(repo)
      if (!w) watchers.set(repo, (w = watchRepo(repo)))
      w.clients.add(res)
      req.on('close', () => {
        w.clients.delete(res)
        if (w.clients.size === 0 && watchers.get(repo) === w) {
          w.close()
          watchers.delete(repo)
        }
      })
      return
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-ramulus-token'] !== token) {
        sendJson(res, 401, { error: 'bad token' })
        return
      }
      const name = url.pathname.slice(5)
      const shell = Object.hasOwn(SHELL, name) ? SHELL[name] : undefined
      const op = Object.hasOwn(ops, name) ? ops[name] : undefined
      if ((!op && !shell) || req.method !== 'POST') {
        sendJson(res, 404, { error: 'unknown operation' })
        return
      }
      try {
        const body = await readBody(req)
        const repo = body.repo ?? dir
        if (!shell && !known.has(repo)) throw new Error('Open that repository first')
        sendJson(res, 200, { result: (await (shell ? shell(body) : op(repo, body, res))) ?? null })
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    const rel = url.pathname === '/' ? '/index.html' : url.pathname
    const file = join(uiDir, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(uiDir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
    createReadStream(file).pipe(res)
  })
  // One socket carries every terminal tab the page shows, each on a channel number the page picks: `attach` starts the
  // tab's output, `input` and `resize` go to it, `detach` ends it. Keystrokes stop waiting behind other requests.
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    if (url.pathname !== '/api/term' || url.searchParams.get('token') !== token) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const chans = new Map()
      const detach = (ch) => {
        chans.get(ch)?.detach()
        chans.delete(ch)
      }
      ws.on('message', (raw) => {
        let m
        try {
          m = JSON.parse(raw)
        } catch {
          return
        }
        const ch = m?.ch
        if (!Number.isSafeInteger(ch) || ch < 0) return
        const c = chans.get(ch)
        if (m.op === 'attach') {
          detach(ch)
          const repo = m.repo ?? dir
          let id
          try {
            id = termId(m.id)
          } catch {}
          if (!id || !known.has(repo)) return ws.send(JSON.stringify({ ch, exit: null }))
          const entry = { repo, id, detach: () => {} }
          chans.set(ch, entry)
          entry.detach = terms.attach(repo, id, (out) => ws.send(JSON.stringify({ ch, ...out })))
        } else if (m.op === 'input' && c) terms.write(c.repo, c.id, m.data ?? '')
        else if (m.op === 'resize' && c) terms.resize(c.repo, c.id, m.cols, m.rows)
        else if (m.op === 'detach') detach(ch)
      })
      ws.on('close', () => [...chans.keys()].forEach(detach))
    })
  })
  server.stopAgents = () => {
    terms.stopAll()
    ai.killAll()
  }
  return server
}
