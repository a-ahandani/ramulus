import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import * as ai from '../lib/ai.js'
import { trimTail } from '../lib/term.js'
import { createServer } from '../lib/server.js'
import WebSocket from 'ws'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ramulus-ai-test-')))
const bin = join(root, 'bin')
const repo = join(root, 'repo')
const PATH = `${bin}${delimiter}${process.env.PATH}`
const env = { ...process.env, PATH }

before(() => {
  mkdirSync(bin)
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nif defined FAIL goto fail\r\nif defined SHOWDIR (cd & exit /b 0)\r\nif defined SLOW ping -n 30 127.0.0.1 >nul\r\nmore\r\nexit /b 0\r\n:fail\r\necho {"error":{"message":"not signed in"}} 1>&2\r\nexit /b 1\r\n')
  } else {
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nif [ -n "$FAIL" ]; then echo \'{"error":{"message":"not signed in"}}\' >&2; exit 1; fi\nif [ -n "$SHOWDIR" ]; then pwd; exit 0; fi\nif [ -n "$SLOW" ]; then sleep 30; fi\ncat\n')
    chmodSync(join(bin, 'claude'), 0o755)
  }
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, 'config', 'core.autocrlf', 'false'])
})

after(() => rmSync(root, { recursive: true, force: true }))

describe('AI agents', () => {
  it('finds installed agents on the PATH', () => {
    assert.deepEqual(ai.detect({ ...env, PATH: bin }), [{ id: 'claude', name: 'Claude Code' }])
    assert.deepEqual(ai.detect({ ...env, PATH: join(root, 'none') }), [])
  })

  it('sends the prompt on stdin and returns the reply', async () => {
    assert.equal(await ai.ask('claude', 'feat/login-form', { env }), 'feat/login-form')
    await assert.rejects(ai.ask('nope', 'x', { env }), /not installed/)
  })

  it('runs drafts outside the repository so its agent config never loads', async () => {
    const where = await ai.ask('claude', 'x', { env: { ...env, SHOWDIR: '1' } })
    assert.ok(!where.includes(repo), where)
  })

  it('stops every running draft when the helper quits', async () => {
    const started = Date.now()
    const pending = ai.ask('claude', 'x', { env: { ...env, SLOW: '1' } })
    setTimeout(ai.killAll, 300)
    await assert.rejects(pending)
    assert.ok(Date.now() - started < 5000)
  })

  it('keeps a bounded replay buffer even without newlines', () => {
    assert.equal(trimTail('x'.repeat(300), 100).length, 100)
    assert.equal(trimTail(`${'a'.repeat(50)}\n${'b'.repeat(80)}`, 100), 'b'.repeat(80))
    assert.equal(trimTail('short', 100), 'short')
  })

  it("reports the agent's own error", async () => {
    await assert.rejects(ai.ask('claude', 'x', { env: { ...env, FAIL: '1' } }), /Claude Code: not signed in/)
  })

  it('stops a running agent at once', async () => {
    const stop = new AbortController()
    const started = Date.now()
    setTimeout(() => stop.abort(), 300)
    await assert.rejects(ai.ask('claude', 'x', { env: { ...env, SLOW: '1' }, signal: stop.signal }), /Stopped/)
    assert.ok(Date.now() - started < 5000)
  })

  it('keeps only known settings', () => {
    assert.deepEqual(ai.cleanSettings({ enabled: 'yes', agent: 'other', prompts: { commit: 'Short please', branch: '  ', evil: 'x' } }), { prompts: { commit: 'Short please' } })
  })
})

describe('AI through the helper', () => {
  let server
  let base
  const saved = process.env.PATH
  const call = (op, body = {}) =>
    fetch(`${base}/api/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ramulus-token': 't'.repeat(32) }, body: JSON.stringify(body) }).then((r) => r.json())

  before(async () => {
    process.env.PATH = PATH
    server = createServer({ dir: repo, uiDir: root, token: 't'.repeat(32), stateFile: join(root, 'state', 'recent.json') })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${server.address().port}`
  })

  const sockets = []
  // a terminal tab attached on its own socket, the way the page attaches it
  const attach = async (id, at = repo, token = 't'.repeat(32)) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/term?token=${token}`)
    sockets.push(ws)
    await new Promise((open, fail) => (ws.once('open', open), ws.once('error', fail)))
    const t = { seen: '' }
    const waiters = new Set()
    ws.on('message', (m) => {
      t.seen += m.toString()
      for (const w of waiters) w()
    })
    const send = (m) => ws.send(JSON.stringify({ ch: 1, ...m }))
    send({ op: 'attach', repo: at, id })
    t.input = (data) => send({ op: 'input', data })
    t.resize = (cols, rows) => send({ op: 'resize', cols, rows })
    t.until = (text) =>
      new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`never saw ${text}; saw ${t.seen}`)), 10000)
        const check = () => t.seen.includes(text) && (clearTimeout(timer), waiters.delete(check), done())
        waiters.add(check)
        check()
      })
    return t
  }

  after(() => {
    process.env.PATH = saved
    for (const ws of sockets) ws.terminate()
    server.close()
  })

  it('asks first, then runs the chosen agent with the repository context', async () => {
    const info = (await call('ai')).result
    assert.ok(info.agents.some((a) => a.id === 'claude'))
    assert.deepEqual(info.settings, { prompts: {} })
    assert.match((await call('aiAsk', { agent: 'claude', prompt: 'hi' })).error, /turned off/)
    await call('setAi', { settings: { enabled: true, agent: 'claude', prompts: { commit: 'Be brief' } } })
    assert.deepEqual((await call('ai')).result.settings, { enabled: true, agent: 'claude', prompts: { commit: 'Be brief' } })
    writeFileSync(join(repo, 'notes.txt'), 'hello\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    const ctx = (await call('aiContext', { task: 'commit' })).result
    assert.match(ctx, /notes\.txt/)
    assert.match(ctx, /\+hello/)
    assert.equal((await call('aiAsk', { agent: 'claude', prompt: 'Add notes' })).result, 'Add notes')
  })

  it('runs the agent in a terminal and streams what it prints', { timeout: 20000 }, async () => {
    assert.equal((await call('termStart', { agent: 'claude', cols: 80, rows: 24 })).result.fresh, true)
    const term = await attach()
    term.input('hello ramulus\r')
    await term.until('hello ramulus')
    assert.equal((await call('termStart', { agent: 'claude', cols: 100, rows: 30 })).result.fresh, false)
    await call('termStop')
    await term.until('"exit":')
  })

  it('keeps each terminal tab separate and stops them one at a time', { timeout: 20000 }, async () => {
    assert.equal((await call('termStart', { id: 'one', agent: 'claude', cols: 80, rows: 24 })).result.fresh, true)
    assert.equal((await call('termStart', { id: 'two', agent: 'claude', cols: 80, rows: 24 })).result.fresh, true)
    // Windows' cmd.exe names its window as it starts, so the titles can be there already
    assert.deepEqual((await call('termList')).result.map(({ title, ...t }) => t), [
      { id: 'one', kind: 'agent', agent: 'claude' },
      { id: 'two', kind: 'agent', agent: 'claude' },
    ])
    const one = await attach('one')
    const two = await attach('two')
    two.input('only in two\r')
    await two.until('only in two')
    one.input('only in one\r')
    await one.until('only in one')
    assert.doesNotMatch(one.seen, /only in two/)
    await call('termStop', { id: 'one' })
    await one.until('"exit":')
    two.input('still here\r')
    await two.until('still here')
    assert.match((await call('termStart', { id: 'Bad Id', agent: 'claude' })).error, /Invalid terminal id/)
    await call('termStop', { all: true })
    await two.until('"exit":')
  })

  it('replays what a terminal printed before the tab attached', { timeout: 20000 }, async () => {
    await call('termStart', { id: 'late', agent: 'claude', cols: 80, rows: 24 })
    const typing = await attach('late')
    typing.input('typed before attach\r')
    await typing.until('typed before attach')
    const late = await attach('late')
    await late.until('typed before attach')
    assert.ok(late.seen.startsWith('{"ch":1,"replay":'), late.seen)
    await call('termStop', { id: 'late' })
    await late.until('"exit":')
    await (await attach('late')).until('{"ch":1,"exit":null}')
  })

  it('refuses a terminal socket without the token or for a folder not opened', async () => {
    await assert.rejects(attach('main', repo, 'nope'), /401/)
    const plain = await fetch(`${base}/api/term?token=${'t'.repeat(32)}`)
    assert.equal(plain.status, 400)
    assert.equal(await plain.text(), "Connection header did not include 'upgrade'")
    await (await attach('main', join(root, 'other'))).until('{"ch":1,"exit":null}')
  })

  it('opens a plain shell tab without the AI setting', { timeout: 20000, skip: process.platform === 'win32' }, async () => {
    await call('setAi', { settings: { enabled: false, prompts: {} } })
    assert.match((await call('termStart', { id: 'agent', agent: 'claude' })).error, /turned off/)
    assert.equal((await call('termStart', { id: 'sh', kind: 'shell', cols: 80, rows: 24 })).result.agent, undefined)
    const sh = await attach('sh')
    sh.resize(100, 30)
    sh.input('stty size\r')
    await sh.until('30 100')
    await call('termStop', { id: 'sh' })
  })
})
