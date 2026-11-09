import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createTerminals, lastTitle } from '../lib/term.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ramulus-term-')))
after(() => rmSync(root, { recursive: true, force: true }))

// collects what a tab prints, the way the browser's stream does
const watch = (terms, id) => {
  let seen = ''
  const waiters = []
  terms.attach(root, id, (msg) => {
    seen += JSON.stringify(msg)
    for (const w of waiters) w()
  })
  return (text) =>
    new Promise((done, fail) => {
      const t = setTimeout(() => fail(new Error(`never saw ${text}; saw ${seen}`)), 10000)
      const check = () => seen.includes(text) && (clearTimeout(t), done())
      waiters.push(check)
      check()
    })
}

describe('terminals', () => {
  it('reads the title a program gives its terminal', () => {
    assert.equal(lastTitle('\x1b]0;✳ Claude Code\x07hello'), '✳ Claude Code')
    assert.equal(lastTitle('\x1b]2;first\x1b\\ \x1b]0;second\x07'), 'second')
    assert.equal(lastTitle('\x1b]0;unfinished'), undefined)
    assert.equal(lastTitle('\x1b]7501;?\x07\x1b]8;;link\x07'), undefined)
    assert.equal(lastTitle('\x1b]0;cut\x1b[0m\x07'), undefined)
  })

  it('brings tabs back after the helper restarts', { skip: process.platform === 'win32' }, async () => {
    const dir = join(root, 'state')
    const env = { ...process.env, SHELL: '/bin/sh' }
    const first = createTerminals(dir)
    await first.start(root, 'sh', 'shell', '', 80, 24, env)
    const seen = watch(first, 'sh')
    first.write(root, 'sh', 'printf "\\033]0;%s\\007" titled; echo kept-$((40+2))\r')
    await seen('kept-42')
    // a second helper beside this one leaves its saved tabs alone
    assert.deepEqual(createTerminals(dir).list(root), [])
    assert.deepEqual(first.list(root), [{ id: 'sh', kind: 'shell', agent: undefined, title: 'titled' }])
    // a drag in the page reorders the tabs, and they come back in that order
    await first.start(root, 'b', 'shell', '', 80, 24, env)
    first.order(root, ['b', 'sh', 'gone'])
    assert.deepEqual(first.list(root).map((t) => t.id), ['b', 'sh'])
    first.stopAll()

    const again = createTerminals(dir)
    assert.deepEqual(again.list(root).map((t) => t.id), ['b', 'sh'])
    assert.deepEqual(again.list(root)[1], { id: 'sh', kind: 'shell', agent: undefined, title: 'titled' })
    assert.equal((await again.start(root, 'sh', 'shell', '', 80, 24, env)).fresh, true)
    const replay = watch(again, 'sh')
    await replay('kept-42')
    await replay('new session')
    again.stop(root, 'sh')
    again.stop(root, 'b')
    again.stopAll()
    assert.deepEqual(createTerminals(dir).list(root), [])
  })
})
