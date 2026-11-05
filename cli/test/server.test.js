import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createServer } from '../lib/server.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ramulus-srv-')))
const repo = (name) => {
  const d = join(root, name)
  execFileSync('git', ['init', '-q', '-b', 'main', d])
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: d, encoding: 'utf8' }).trim()
}
const first = repo('first')
const second = repo('second')
const token = 'a'.repeat(32)
let server
let base

const call = async (op, body = {}, tok = token) => {
  const res = await fetch(`${base}/api/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ramulus-token': tok }, body: JSON.stringify(body) })
  return res.json()
}

before(async () => {
  server = createServer({ dir: first, uiDir: root, token, stateFile: join(root, 'state', 'recent.json') })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('helper server', () => {
  it('starts outside a repository and lists the repositories below it', async () => {
    for (const skipped of [join('x', 'node_modules', 'dep'), join('.hidden', 'y'), join('a', 'b', 'c', 'd')]) execFileSync('git', ['init', '-q', join(root, skipped)])
    const bare = createServer({ root, uiDir: root, token, stateFile: join(root, 'state2', 'recent.json') })
    await new Promise((done) => bare.listen(0, '127.0.0.1', done))
    const at = `http://127.0.0.1:${bare.address().port}`
    const post = (op, body = {}) => fetch(`${at}/api/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ramulus-token': token }, body: JSON.stringify(body) }).then((r) => r.json())
    try {
      assert.equal((await post('repos')).result.current, null)
      assert.deepEqual((await post('findRepos')).result.repos.map((r) => r.name), ['first', 'second'])
      assert.match((await post('status')).error, /Open that repository first/)
      assert.equal((await post('openRepo', { path: './second' })).result.name, 'second')
      assert.deepEqual((await post('status', { repo: second })).result.unstaged, [])
    } finally {
      bare.close()
    }
  })


  it('offers the repositories nested inside the one it started in', async () => {
    execFileSync('git', ['init', '-q', join(first, 'libs', 'inner')])
    const r = (await call('findRepos')).result
    assert.equal(r.root, first)
    assert.equal(r.inside, true)
    assert.deepEqual(r.repos.map((x) => x.name), ['inner'])
    rmSync(join(first, 'libs'), { recursive: true, force: true })
  })

  it('keeps preferences across runs', async () => {
    assert.deepEqual((await call('prefs')).result, {})
    await call('setPrefs', { prefs: { theme: 'light', scheme: { id: 'x' } } })
    assert.deepEqual((await call('prefs')).result, { theme: 'light', scheme: { id: 'x' } })
    assert.match((await call('setPrefs', { prefs: { big: 'x'.repeat(30000) } })).error, /too large/)
  })

  it('only touches repositories the user opened', async () => {
    assert.equal((await call('status', {}, 'b'.repeat(32))).error, 'bad token')
    assert.deepEqual((await call('status')).result.unstaged, [])
    assert.match((await call('status', { repo: second })).error, /Open that repository first/)
    assert.match((await call('openRepo', { path: join(root, 'missing') })).error, /does not exist/)
    assert.equal((await call('openRepo', { path: join(second, '.') })).result.name, 'second')
    assert.deepEqual((await call('status', { repo: second })).result.unstaged, [])
    const repos = (await call('repos')).result
    assert.equal(repos.current.dir, first)
    assert.deepEqual(repos.recent.map((r) => r.name), ['second', 'first'])
    assert.equal((await call('constructor')).error, 'unknown operation')
    await call('setPins', { dirs: [second, join(root, 'gone'), 42] })
    assert.deepEqual((await call('pins')).result.map((r) => r.name), ['second'])
    const events = (repo) => fetch(`${base}/api/events?token=${token}&repo=${encodeURIComponent(repo)}`, { signal: AbortSignal.timeout(2000) })
    assert.equal((await events(join(root, 'other'))).status, 401)
    const open = await events(second)
    assert.equal(open.status, 200)
    await open.body.cancel()
  })

  it('opens a folder without git and starts a repository in it', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const opened = (await call('openRepo', { path: plain })).result
    assert.equal(opened.name, 'plain')
    assert.match((await call('load', { repo: opened.dir })).error, /not a git repository/)
    assert.equal((await call('init', { repo: opened.dir })).result, null)
    assert.deepEqual((await call('status', { repo: opened.dir })).result.unstaged, [])
  })
})
