import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'ramulus-bin-'))
const stub = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ramulus.js')
const run = (args, modules) => spawnSync(process.execPath, [stub, ...args], { env: { ...process.env, NODE_PATH: modules, RAMULUS_NODE: '' }, encoding: 'utf8' })

after(() => rmSync(root, { recursive: true, force: true }))

describe('the ramulus command', { skip: process.platform === 'win32' }, () => {
  it('runs the native helper when its platform package is installed and passes its exit code on', () => {
    const pkg = join(root, 'node_modules', `ramulus-${process.platform}-${process.arch}`)
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    writeFileSync(join(pkg, 'bin', 'ramulus'), '#!/bin/sh\necho "native $@"\nexit 7\n')
    chmodSync(join(pkg, 'bin', 'ramulus'), 0o755)
    const r = run(['--no-open'], join(root, 'node_modules'))
    assert.equal(r.status, 7)
    assert.match(r.stdout, /^native --no-open --ui .*ui\n$/)
  })

  it('serves with the Node helper when there is no native one', () => {
    const r = run(['--help'], join(root, 'none'))
    assert.equal(r.status, 0)
    assert.match(r.stdout, /^Usage: ramulus/)
  })
})
