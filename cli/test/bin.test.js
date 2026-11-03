import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..')
const native = join(cli, 'native', `${process.platform}-${process.arch}`)
const run = (args, env = {}) => spawnSync(process.execPath, [join(cli, 'bin', 'ramulus.js'), ...args], { env: { ...process.env, RAMULUS_NODE: '', ...env }, encoding: 'utf8' })

after(() => rmSync(native, { recursive: true, force: true }))

describe('the ramulus command', { skip: process.platform === 'win32' || existsSync(native) }, () => {
  it('runs the native helper the package carries and passes its exit code on', () => {
    mkdirSync(native, { recursive: true })
    writeFileSync(join(native, 'ramulus'), '#!/bin/sh\necho "native $@"\nexit 7\n')
    chmodSync(join(native, 'ramulus'), 0o755)
    const r = run(['--no-open'])
    assert.equal(r.status, 7)
    assert.match(r.stdout, /^native --no-open --ui .*ui\n$/)
  })

  it('serves with the Node helper when told to, or when there is no native one', () => {
    const r = run(['--help'], { RAMULUS_NODE: '1' })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /^Usage: ramulus/)
    rmSync(native, { recursive: true, force: true })
    assert.match(run(['--help']).stdout, /^Usage: ramulus/)
  })
})
