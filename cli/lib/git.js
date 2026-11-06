import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const NUL = '\0'
const RS = '\x1e'

export function run(dir, args, { input, allowFail = false, buffer = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd: dir, maxBuffer: 256 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        if (err && !allowFail) {
          const msg = (stderr || stdout || err.message).toString().trim()
          reject(new Error(msg || `git ${args[0]} failed`))
        } else {
          resolve({ ok: !err, stdout: buffer ? stdout : stdout.toString(), stderr: stderr.toString() })
        }
      },
    )
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function safeName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.startsWith('-')) throw new Error(`Invalid name: ${JSON.stringify(name)}`)
  return name
}

function safePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('No files given')
  return paths.map((p) => {
    if (typeof p !== 'string' || p.length === 0) throw new Error('Invalid path')
    return p
  })
}

export function gitProblem(versionText) {
  const v = /(\d+)\.(\d+)/.exec(versionText ?? '')
  if (!v) return 'Ramulus needs git. Install it from https://git-scm.com/downloads and run it again.'
  if (Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 23)) return `Ramulus needs git 2.23 or newer, and this is git ${v[1]}.${v[2]}. Update it from https://git-scm.com/downloads`
}

export async function files(dir) {
  return [...new Set((await run(dir, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean))]
}

export async function toplevel(dir) {
  return (await run(dir, ['rev-parse', '--show-toplevel'])).stdout.trim()
}

async function stateOf(dir) {
  const gitDir = (await run(dir, ['rev-parse', '--git-dir'])).stdout.trim()
  const at = (p) => existsSync(join(dir, gitDir, p))
  if (at('MERGE_HEAD')) return 'merge'
  if (at('rebase-merge') || at('rebase-apply')) return 'rebase'
  if (at('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (at('REVERT_HEAD')) return 'revert'
  return null
}

export function parseStatus(porcelainZ) {
  const out = { staged: [], unstaged: [] }
  const items = porcelainZ.split(NUL)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.length < 4) continue
    const x = item[0]
    const y = item[1]
    let path = item.slice(3)
    if (x === 'R' || x === 'C') {
      i++
    }
    if (x === '?') {
      out.unstaged.push({ path, kind: '?' })
      continue
    }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      out.unstaged.push({ path, kind: 'M', conflict: true })
      continue
    }
    if (x !== ' ') out.staged.push({ path, kind: x === 'A' ? 'A' : x === 'D' ? 'D' : 'M' })
    if (y !== ' ') out.unstaged.push({ path, kind: y === 'D' ? 'D' : 'M' })
  }
  return out
}

// The new path of a numstat rename, written as `src/{a.ts => b.ts}` or `a.ts => b.ts`; other paths come back as they are.
function renamedTo(path) {
  const after = (s) => s.split(' => ').pop()
  const l = path.indexOf('{')
  const r = path.indexOf('}')
  return l >= 0 && r > l ? path.slice(0, l) + after(path.slice(l + 1, r)) + path.slice(r + 1) : after(path)
}

function parseNumstat(text) {
  const out = new Map()
  for (const line of text.split('\n')) {
    const [a, d, ...rest] = line.split('\t')
    const path = rest.join('\t')
    if (!path) continue
    out.set(renamedTo(path), { added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d) })
  }
  return out
}

function withStats(files, stats) {
  for (const f of files) {
    const s = stats.get(f.path)
    if (s) Object.assign(f, s)
  }
  return files
}

export async function status(dir) {
  const [st, unstagedStats, stagedStats] = await Promise.all([
    run(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    run(dir, ['diff', '--numstat', '-M'], { allowFail: true }),
    run(dir, ['diff', '--numstat', '-M', '--cached'], { allowFail: true }),
  ])
  const parsed = parseStatus(st.stdout)
  withStats(parsed.unstaged, parseNumstat(unstagedStats.stdout))
  withStats(parsed.staged, parseNumstat(stagedStats.stdout))
  return { ...parsed, state: await stateOf(dir) }
}

export function parseLog(text, stashInfo) {
  const commits = []
  for (const rec of text.split(RS)) {
    const t = rec.replace(/^\n/, '')
    if (!t.trim()) continue
    const [id, parents, author, email, time, summary, body = ''] = t.split(NUL)
    if (!id) continue
    if (stashInfo.internals.has(id)) continue
    const stash = stashInfo.messages.get(id)
    const ps = parents ? parents.split(' ') : []
    commits.push({
      id,
      parents: stash !== undefined ? ps.slice(0, 1) : ps,
      author,
      email,
      time: Number(time),
      summary: stash ?? summary,
      body: body.trim(),
      kind: stash !== undefined ? 'stash' : ps.length > 1 ? 'merge' : 'commit',
    })
  }
  return commits
}

export async function load(dir, limit = 2000) {
  const headBranch = (await run(dir, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })).stdout.trim() || undefined
  const headOid = (await run(dir, ['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true })).stdout.trim() || undefined
  const refsByOid = {}
  const addRef = (oid, label) => (refsByOid[oid] ??= []).push(label)
  const local = []
  const remote = []
  const tags = []
  const refs = await run(dir, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(symref)%00%(upstream:short)%00%(upstream:track)', 'refs/heads', 'refs/remotes', 'refs/tags'])
  for (const line of refs.stdout.split('\n')) {
    if (!line) continue
    const [refname, objectname, peeled, symref, upstream, track] = line.split(NUL)
    if (symref) continue
    const oid = peeled || objectname
    if (refname.startsWith('refs/heads/')) {
      const name = refname.slice(11)
      const ahead = Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0)
      const behind = Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0)
      local.push({ name, oid, isHead: name === headBranch, upstream: upstream || undefined, ahead, behind, gone: /gone/.test(track ?? '') })
      addRef(oid, { name, kind: 'head', current: name === headBranch })
    } else if (refname.startsWith('refs/remotes/')) {
      const name = refname.slice(13)
      remote.push({ name, oid, isHead: false })
      addRef(oid, { name, kind: 'remote' })
    } else if (refname.startsWith('refs/tags/')) {
      const name = refname.slice(10)
      tags.push({ name, oid })
      addRef(oid, { name, kind: 'tag' })
    }
  }
  const stashes = []
  const stashList = await run(dir, ['stash', 'list', '--format=%H%x00%s'], { allowFail: true })
  for (const line of stashList.stdout.split('\n')) {
    if (!line) continue
    const [oid, message] = line.split(NUL)
    stashes.push({ index: stashes.length, message, oid })
  }
  const internals = new Set()
  if (stashes.length > 0) {
    const parents = await run(dir, ['rev-list', '--no-walk', '--parents', ...stashes.map((s) => s.oid)])
    for (const line of parents.stdout.split('\n')) {
      const [, ...ps] = line.trim().split(' ')
      ps.slice(1).forEach((p) => internals.add(p))
    }
  }
  const log = await run(dir, [
    'log',
    '--date-order',
    `--max-count=${limit + 1 + internals.size}`,
    '--format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%s%x00%b%x1e',
    '--all',
  ], { allowFail: true })
  const commits = parseLog(log.stdout, { internals, messages: new Map(stashes.map((s) => [s.oid, s.message])) })
  const hasMore = commits.length > limit
  return {
    name: dir.split(/[\\/]/).filter(Boolean).pop(),
    headBranch,
    headOid,
    originUrl: (await run(dir, ['remote', 'get-url', 'origin'], { allowFail: true })).stdout.trim() || undefined,
    commits: commits.slice(0, limit),
    refsByOid,
    local,
    remote,
    tags,
    stashes,
    status: await status(dir),
    hasMore,
    native: true,
  }
}

async function parentOf(dir, oid) {
  return (await run(dir, ['rev-parse', '-q', '--verify', `${oid}^`], { allowFail: true })).stdout.trim() || undefined
}

export async function commitFiles(dir, oid) {
  const parent = await parentOf(dir, oid)
  const args = parent ? ['diff-tree', '-r', '-z', '-M', '--name-status', parent, oid] : ['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--name-status', oid]
  const [{ stdout }, stats] = await Promise.all([run(dir, args), run(dir, args.map((a) => (a === '--name-status' ? '--numstat' : a)).filter((a) => a !== '-z'), { allowFail: true })])
  const parts = stdout.split(NUL)
  const out = []
  for (let i = 0; i < parts.length - 1; i += 2) {
    const code = parts[i][0]
    let path = parts[i + 1]
    if (code === 'R' || code === 'C') {
      path = parts[i + 2]
      i++
    }
    if (!path) continue
    out.push({ path, kind: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M' })
  }
  return withStats(out, parseNumstat(stats.stdout))
}

const MAX_TEXT = 2_000_000

function isBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function showBytes(dir, spec) {
  const size = await run(dir, ['cat-file', '-s', spec], { allowFail: true })
  if (!size.ok) return undefined
  if (Number(size.stdout) > MAX_TEXT) return 'big'
  const r = await run(dir, ['cat-file', '--filters', spec], { allowFail: true, buffer: true })
  return r.ok ? r.stdout : undefined
}

export async function fileVersions(dir, area, path) {
  safePaths([path])
  let oldData
  let newData
  if (area.kind === 'commit') {
    const parent = await parentOf(dir, area.oid)
    oldData = parent ? await showBytes(dir, `${parent}:${path}`) : undefined
    newData = await showBytes(dir, `${safeName(area.oid)}:${path}`)
  } else if (area.kind === 'staged') {
    oldData = await showBytes(dir, `HEAD:${path}`)
    newData = await showBytes(dir, `:${path}`)
  } else {
    oldData = (await showBytes(dir, `:${path}`)) ?? (await showBytes(dir, `HEAD:${path}`))
    const full = insideRepo(dir, path)
    const st = await lstat(full).catch(() => undefined)
    newData = !st ? undefined : st.isSymbolicLink() || st.size > MAX_TEXT ? 'big' : await readFile(full)
  }
  const binary = [oldData, newData].some((b) => b === 'big' || (b && isBinary(b)))
  return { old: binary || !oldData ? '' : oldData.toString('utf8'), new: binary || !newData ? '' : newData.toString('utf8'), binary }
}

const CHANGED = 'The file changed since this diff was loaded. Look at it again and retry.'

export async function writeIndex(dir, path, content, expected) {
  safePaths([path])
  if (expected !== undefined) {
    const cur = await showBytes(dir, `:${path}`)
    if ((cur && cur !== 'big' ? cur.toString('utf8') : '') !== expected) throw new Error(CHANGED)
  }
  const oid = (await run(dir, ['hash-object', '-w', '--stdin', `--path=${path}`], { input: content })).stdout.trim()
  const entry = (await run(dir, ['ls-files', '-s', '--', path], { allowFail: true })).stdout.trim()
  const mode = entry ? entry.split(' ')[0] : '100644'
  await run(dir, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`])
}

function insideRepo(dir, path) {
  const full = resolve(dir, path)
  if (!full.startsWith(resolve(dir) + sep)) throw new Error('Path is outside the repository')
  return full
}

export async function writeWorkdir(dir, path, content, expected) {
  safePaths([path])
  const full = insideRepo(dir, path)
  if (await lstat(full).then((s) => s.isSymbolicLink(), () => false)) throw new Error('That path is a symbolic link')
  if (expected !== undefined && (await readFile(full).then((b) => b.toString('utf8'), () => '')) !== expected) throw new Error(CHANGED)
  await writeFile(full, content)
}

const cap = (text, n = 80000) => (text.length > n ? `${text.slice(0, n)}\n[${text.length - n} more characters left out]` : text)

export async function aiContext(dir, task, extra = {}) {
  const out = async (args) => (await run(dir, args, { allowFail: true })).stdout.trim()
  const recent = `Recent commit subjects:\n${await out(['log', '-15', '--format=%s'])}`
  if (task === 'commit') return `${recent}\n\nStaged changes:\n${cap(`${await out(['diff', '--cached', '--stat'])}\n\n${await out(['diff', '--cached'])}`)}`
  if (task === 'branch') {
    const branches = (await out(['branch', '-a', '--format=%(refname:short)'])).split('\n').slice(0, 80).join('\n')
    const at = extra.at ? `\n\nThe new branch starts at this commit:\n${await out(['log', '-1', '--format=%s%n%n%b', safeName(extra.at)])}` : ''
    return `Existing branches:\n${branches}${at}\n\nUncommitted changes:\n${cap(`${await out(['status', '--short'])}\n\n${await out(['diff', 'HEAD'])}`)}`
  }
  throw new Error('Unknown task')
}

export async function findRepos(root, depth = 3, limit = 100) {
  const found = []
  let level = [root]
  for (let d = 0; d < depth && level.length && found.length < limit; d++) {
    const next = []
    for (const dir of level) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
        const full = join(dir, e.name)
        if (existsSync(join(full, '.git'))) found.push(full)
        else next.push(full)
        if (found.length >= limit) break
      }
      if (found.length >= limit) break
    }
    level = next
  }
  return found.sort((a, b) => a.localeCompare(b))
}

const PICKERS = {
  darwin: ['osascript', ['-e', 'POSIX path of (choose folder with prompt "Open a repository")']],
  // the hidden TopMost owner keeps the dialog above the browser; without one Windows opens it behind
  win32: ['powershell', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost = $true})) -eq 'OK') { $d.SelectedPath }"]],
}

export function pickFolder() {
  const [cmd, args] = PICKERS[process.platform] ?? ['zenity', ['--file-selection', '--directory', '--title=Open a repository']]
  return new Promise((done, fail) =>
    execFile(cmd, args, (err, stdout) => {
      if (err?.code === 'ENOENT') fail(new Error('No folder picker is available here. Type the path instead.'))
      else done(err ? null : stdout.trim() || null)
    }),
  )
}

export function openPath(dir, path) {
  safePaths([path])
  const full = insideRepo(dir, path)
  if (!existsSync(full)) throw new Error('That file no longer exists')
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', full] : [full]
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

export async function stage(dir, paths) {
  await run(dir, ['add', '-A', '--', ...safePaths(paths)])
}

export async function unstage(dir, paths) {
  await run(dir, ['reset', '-q', '--', ...safePaths(paths)])
}

export async function discard(dir, files) {
  const tracked = files.filter((f) => f.kind !== '?').map((f) => f.path)
  const untracked = files.filter((f) => f.kind === '?').map((f) => f.path)
  if (tracked.length) await run(dir, ['checkout', '-q', '--', ...safePaths(tracked)])
  if (untracked.length) await run(dir, ['clean', '-f', '-q', '--', ...safePaths(untracked)])
}

export async function commit(dir, message, amend) {
  if (!message || !message.trim()) throw new Error('A commit message is required')
  await run(dir, ['commit', '-q', '-F', '-', ...(amend ? ['--amend'] : [])], { input: message })
}

export async function checkoutBranch(dir, name) {
  await run(dir, ['switch', '-q', safeName(name)])
}

export async function checkoutRemote(dir, name) {
  safeName(name)
  const local = name.slice(name.indexOf('/') + 1)
  const exists = (await run(dir, ['rev-parse', '-q', '--verify', `refs/heads/${local}`], { allowFail: true })).ok
  const dirty = (await run(dir, ['status', '--porcelain', '-uno'])).stdout.trim() !== ''
  if (dirty) await run(dir, ['stash', 'push', '-q', '-m', 'autostash'])
  let out
  try {
    if (!exists) {
      await run(dir, ['switch', '-q', '-c', local, '--track', name])
      out = { result: 'created', local }
    } else {
      await run(dir, ['switch', '-q', local])
      const [ahead = 0, behind = 0] = (await run(dir, ['rev-list', '--left-right', '--count', `HEAD...${name}`])).stdout.trim().split(/\s+/).map(Number)
      if (behind && !ahead) await run(dir, ['merge', '-q', '--ff-only', name])
      out = { result: behind ? (ahead ? 'diverged' : 'updated') : 'up-to-date', local, ahead, behind }
    }
  } catch (e) {
    if (dirty) await run(dir, ['stash', 'pop', '-q', '--index'], { allowFail: true })
    throw e
  }
  if (!dirty) return out
  const back = (await run(dir, ['stash', 'pop', '-q', '--index'], { allowFail: true })).ok || (!(await hasUnmerged(dir)) && (await run(dir, ['stash', 'pop', '-q'], { allowFail: true })).ok)
  return { ...out, stash: back ? 'kept' : 'conflicts' }
}

export async function checkoutCommit(dir, oid) {
  await run(dir, ['switch', '-q', '--detach', safeName(oid)])
}

export async function createBranch(dir, name, at, checkout) {
  await run(dir, ['branch', '--', safeName(name), safeName(at)])
  if (checkout) await run(dir, ['switch', '-q', name])
}

export async function deleteBranch(dir, name) {
  await run(dir, ['branch', '-D', '--', safeName(name)])
}

export async function deleteRemoteBranch(dir, name) {
  const remotes = (await run(dir, ['remote'])).stdout.trim().split('\n').filter(Boolean)
  const remote = remotes.filter((r) => typeof name === 'string' && name.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]
  if (!remote) throw new Error(`No remote has the branch ${JSON.stringify(name)}`)
  await run(dir, ['push', '--delete', '--', remote, safeName(name.slice(remote.length + 1))])
}

export async function renameBranch(dir, oldName, newName) {
  await run(dir, ['branch', '-m', '--', safeName(oldName), safeName(newName)])
}

export async function createTag(dir, name, at, message) {
  if (message && message.trim()) await run(dir, ['tag', '-a', '-F', '-', '--', safeName(name), safeName(at)], { input: message })
  else await run(dir, ['tag', '--', safeName(name), safeName(at)])
}

export async function deleteTag(dir, name) {
  await run(dir, ['tag', '-d', '--', safeName(name)])
}

export async function stashSave(dir, message) {
  await run(dir, ['stash', 'push', '-u', '-q', ...(message && message.trim() ? ['-m', message] : [])])
}

export async function stashApply(dir, index, pop) {
  await run(dir, ['stash', pop ? 'pop' : 'apply', '-q', `stash@{${Number(index)}}`])
}

export async function stashDrop(dir, index) {
  await run(dir, ['stash', 'drop', '-q', `stash@{${Number(index)}}`])
}

export async function merge(dir, branch) {
  const r = await run(dir, ['merge', '--no-edit', safeName(branch)], { allowFail: true })
  if (!r.ok) {
    if ((await stateOf(dir)) === 'merge') return 'conflicts'
    throw new Error((r.stderr || r.stdout).trim())
  }
  return /Already up to date/i.test(r.stdout) ? 'up-to-date' : /Fast-forward/.test(r.stdout) ? 'fast-forward' : 'merged'
}

const AUTOSTASH = /autostash$/

async function hasUnmerged(dir) {
  return /^(UU|AA|DD|AU|UA|DU|UD) /m.test((await run(dir, ['status', '--porcelain', '-uno'])).stdout)
}

async function autostashIndex(dir) {
  const list = (await run(dir, ['stash', 'list', '--format=%gs'], { allowFail: true })).stdout.split('\n')
  const i = list.findIndex((s) => AUTOSTASH.test(s.trim()))
  return i < 0 ? undefined : i
}

export async function rebase(dir, onto) {
  const before = (await run(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  const r = await run(dir, ['-c', 'core.editor=true', 'rebase', '--autostash', '--', safeName(onto)], { allowFail: true })
  if (!r.ok) {
    if ((await stateOf(dir)) === 'rebase') return { result: 'conflicts', before }
    throw new Error((r.stderr || r.stdout).trim())
  }
  return { result: (await hasUnmerged(dir)) ? 'stash-conflicts' : 'done', before }
}

export async function undoRebase(dir, before) {
  const last = (await run(dir, ['reflog', '-1', '--format=%gs', 'HEAD'])).stdout.trim()
  const orig = (await run(dir, ['rev-parse', '-q', '--verify', 'ORIG_HEAD'], { allowFail: true })).stdout.trim()
  const want = (await run(dir, ['rev-parse', '-q', '--verify', `${safeName(before)}^{commit}`])).stdout.trim()
  if (!/^rebase/.test(last) || orig !== want) throw new Error('The branch changed after the rebase, so it cannot be undone safely here.')
  const unmerged = await hasUnmerged(dir)
  if (unmerged) await run(dir, ['reset', '-q'])
  const dirty = (await run(dir, ['status', '--porcelain', '-uno'])).stdout.trim()
  if (dirty) await run(dir, ['stash', 'push', '-q', '-m', unmerged ? 'Backup before undoing the rebase' : 'autostash'])
  const reset = await run(dir, ['reset', '-q', '--keep', want], { allowFail: true })
  if (!reset.ok) {
    if (dirty) await run(dir, ['stash', 'pop', '-q'], { allowFail: true })
    throw new Error((reset.stderr || reset.stdout).trim())
  }
  const i = await autostashIndex(dir)
  if (i === undefined) return 'done'
  const pop = await run(dir, ['stash', 'pop', '-q', `stash@{${i}}`], { allowFail: true })
  return pop.ok ? 'done' : 'stash-conflicts'
}

export async function dropAutostash(dir) {
  const i = await autostashIndex(dir)
  if (i !== undefined) await run(dir, ['stash', 'drop', '-q', `stash@{${i}}`])
}

export async function cherryPick(dir, oid) {
  const r = await run(dir, ['cherry-pick', safeName(oid)], { allowFail: true })
  if (!r.ok) {
    if ((await stateOf(dir)) === 'cherry-pick') return 'conflicts'
    throw new Error((r.stderr || r.stdout).trim())
  }
  return 'done'
}

export async function revert(dir, oid) {
  const r = await run(dir, ['revert', '--no-edit', safeName(oid)], { allowFail: true })
  if (!r.ok) {
    if ((await stateOf(dir)) === 'revert') return 'conflicts'
    throw new Error((r.stderr || r.stdout).trim())
  }
  return 'done'
}

export async function reset(dir, oid, mode) {
  if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('Invalid reset mode')
  await run(dir, ['reset', '-q', `--${mode}`, safeName(oid)])
}

export async function abort(dir) {
  const state = await stateOf(dir)
  if (!state) return
  await run(dir, [state, '--abort'])
}

export async function continueOp(dir) {
  const state = await stateOf(dir)
  if (!state) return
  if (state === 'merge') await run(dir, ['-c', 'core.editor=true', 'commit', '-q', '--no-edit'])
  else await run(dir, ['-c', 'core.editor=true', state, '--continue'])
}

export async function fetchAll(dir) {
  await run(dir, ['fetch', '--all', '--prune'])
}

export async function pull(dir, mode) {
  const flags = mode === 'rebase' ? ['--rebase', '--autostash'] : mode === 'ff-only' ? ['--ff-only'] : ['--no-rebase']
  await run(dir, ['pull', ...flags])
}

export async function push(dir, lease) {
  if (lease && !/^[0-9a-f]{40,64}$/.test(lease)) throw new Error('Bad lease')
  const branch = (await run(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
  const upstream = (await run(dir, ['rev-parse', '-q', '--abbrev-ref', '@{u}'], { allowFail: true })).stdout.trim()
  const ref = upstream ? (await run(dir, ['config', '--get', `branch.${branch}.merge`])).stdout.trim() : `refs/heads/${branch}`
  const force = lease ? [`--force-with-lease=${ref}:${lease}`] : []
  let args = ['push', ...force]
  let remote = upstream.split('/')[0]
  let target = '@{u}'
  if (!upstream) {
    const remotes = (await run(dir, ['remote'])).stdout.trim().split('\n').filter(Boolean)
    remote = remotes.includes('origin') ? 'origin' : remotes[0]
    if (!remote) throw new Error('This repository has no remote to push to')
    args = ['push', ...force, '-u', '--', remote, branch]
    target = `${remote}/${branch}`
  }
  const r = await run(dir, args, { allowFail: true })
  if (r.ok) return { result: 'pushed' }
  const text = (r.stderr || r.stdout).trim()
  if (force.length || !/\[rejected\]|non-fast-forward|fetch first/.test(text)) throw new Error(text)
  await run(dir, ['fetch', '-q', '--', remote], { allowFail: true })
  const [ahead = 0, behind = 0] = (await run(dir, ['rev-list', '--left-right', '--count', `HEAD...${target}`], { allowFail: true })).stdout.trim().split(/\s+/).map(Number)
  const theirs = (await run(dir, ['rev-parse', '-q', '--verify', `${target}^{commit}`], { allowFail: true })).stdout.trim()
  return { result: 'rejected', ahead, behind, theirs }
}

export function isRepo(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}
