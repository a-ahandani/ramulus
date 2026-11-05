import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import * as git from '../lib/git.js'

let dir
const sh = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00' } })

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ramulus-cli-'))
  sh('init', '-q', '-b', 'main')
  sh('config', 'user.name', 'Test')
  sh('config', 'user.email', 't@example.com')
  sh('config', 'core.autocrlf', 'false')
})

after(() => rmSync(dir, { recursive: true, force: true }))

describe('git helper', () => {
  it('stages, commits, tags and loads the graph', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    let st = await git.status(dir)
    assert.deepEqual(st.unstaged, [{ path: 'a.txt', kind: '?' }])
    await git.stage(dir, ['a.txt'])
    st = await git.status(dir)
    assert.deepEqual(st.staged, [{ path: 'a.txt', kind: 'A', added: 1, deleted: 0 }])
    await git.commit(dir, 'first', false)
    writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n')
    await git.stage(dir, ['a.txt'])
    await git.commit(dir, 'second\n\nmore detail', false)
    const head = sh('rev-parse', 'HEAD').trim()
    await git.createTag(dir, 'v1', head, 'release one')
    writeFileSync(join(dir, 'b.txt'), 'scratch\n')
    await git.stashSave(dir, 'wip note')
    const data = await git.load(dir)
    assert.equal(data.headBranch, 'main')
    assert.equal(data.headOid, head)
    assert.deepEqual(data.commits.map((c) => c.summary), ['On main: wip note', 'second', 'first'])
    assert.equal(data.commits[0].kind, 'stash')
    assert.equal(data.commits[0].parents.length, 1)
    assert.equal(data.commits[1].body, 'more detail')
    assert.deepEqual(data.tags, [{ name: 'v1', oid: head }])
    assert.ok(data.refsByOid[head].some((r) => r.kind === 'tag' && r.name === 'v1'))
    assert.ok(data.refsByOid[head].some((r) => r.kind === 'head' && r.current))
    assert.equal(data.stashes.length, 1)
    assert.deepEqual(await git.commitFiles(dir, head), [{ path: 'a.txt', kind: 'M', added: 1, deleted: 0 }])
    assert.deepEqual(await git.commitFiles(dir, sh('rev-parse', 'HEAD~1').trim()), [{ path: 'a.txt', kind: 'A', added: 1, deleted: 0 }])
    const v = await git.fileVersions(dir, { kind: 'commit', oid: head }, 'a.txt')
    assert.deepEqual(v, { old: 'hello\n', new: 'hello\nworld\n', binary: false })
  })

  it('refuses option-like names and discards only the named file', async () => {
    await assert.rejects(git.createBranch(dir, '--exec=true', 'HEAD', false), /Invalid name/)
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    writeFileSync(join(dir, 'c.txt'), 'new\n')
    await git.discard(dir, [{ path: 'a.txt', kind: 'M' }])
    const st = await git.status(dir)
    assert.deepEqual(st.unstaged, [{ path: 'c.txt', kind: '?' }])
    await git.discard(dir, [{ path: 'c.txt', kind: '?' }])
    assert.deepEqual((await git.status(dir)).unstaged, [])
  })

  it('reads file versions and writes exact index and working-tree contents', async () => {
    writeFileSync(join(dir, 'h.txt'), 'one\ntwo\nthree\n')
    await git.stage(dir, ['h.txt'])
    await git.commit(dir, 'versions base', false)
    writeFileSync(join(dir, 'h.txt'), 'ONE\ntwo\nTHREE\n')
    let v = await git.fileVersions(dir, { kind: 'unstaged' }, 'h.txt')
    assert.deepEqual(v, { old: 'one\ntwo\nthree\n', new: 'ONE\ntwo\nTHREE\n', binary: false })
    await assert.rejects(git.writeIndex(dir, 'h.txt', 'ONE\ntwo\nthree\n', 'stale\n'), /changed since/)
    await git.writeIndex(dir, 'h.txt', 'ONE\ntwo\nthree\n', v.old)
    v = await git.fileVersions(dir, { kind: 'staged' }, 'h.txt')
    assert.deepEqual(v, { old: 'one\ntwo\nthree\n', new: 'ONE\ntwo\nthree\n', binary: false })
    v = await git.fileVersions(dir, { kind: 'unstaged' }, 'h.txt')
    assert.deepEqual(v, { old: 'ONE\ntwo\nthree\n', new: 'ONE\ntwo\nTHREE\n', binary: false })
    await assert.rejects(git.writeWorkdir(dir, 'h.txt', 'x', 'stale\n'), /changed since/)
    await git.writeWorkdir(dir, 'h.txt', 'ONE\ntwo\nthree\n', v.new)
    const st = await git.status(dir)
    assert.deepEqual(st.unstaged, [])
    assert.deepEqual(st.staged, [{ path: 'h.txt', kind: 'M', added: 1, deleted: 1 }])
    await assert.rejects(git.writeWorkdir(dir, '../outside.txt', 'x'), /outside/)
    const data = await git.load(dir)
    assert.equal(data.local[0].ahead, 0)
    await git.unstage(dir, ['h.txt'])
    await git.discard(dir, [{ path: 'h.txt', kind: 'M' }])
  })

  it('counts lines for a file renamed inside a folder', async () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'a\nb\n')
    await git.stage(dir, ['src/a.ts'])
    await git.commit(dir, 'add a.ts', false)
    sh('mv', 'src/a.ts', 'src/b.ts')
    writeFileSync(join(dir, 'src', 'b.ts'), 'a\nb\nc\n')
    await git.stage(dir, ['src/b.ts'])
    assert.deepEqual((await git.status(dir)).staged, [{ path: 'src/b.ts', kind: 'M', added: 1, deleted: 0 }])
    sh('reset', '-q', '--hard')
  })

  it('lists tracked files and leaves untracked ones to status', async () => {
    writeFileSync(join(dir, 'scratch.tmp'), 'x\n')
    const list = await git.files(dir)
    assert.ok(list.includes('a.txt'))
    assert.ok(!list.includes('scratch.tmp'))
    rmSync(join(dir, 'scratch.tmp'))
  })

  it('parses porcelain status including renames and conflicts', () => {
    const z = 'M  a.txt\0 M b.txt\0R  new.txt\0old.txt\0?? c.txt\0UU d.txt\0'
    assert.deepEqual(git.parseStatus(z), {
      staged: [
        { path: 'a.txt', kind: 'M' },
        { path: 'new.txt', kind: 'M' },
      ],
      unstaged: [
        { path: 'b.txt', kind: 'M' },
        { path: 'c.txt', kind: '?' },
        { path: 'd.txt', kind: 'M', conflict: true },
      ],
    })
  })

  it('names a missing or too old git and accepts current ones', () => {
    assert.match(git.gitProblem(''), /needs git\. Install/)
    assert.match(git.gitProblem('git version 2.22.5'), /2\.23 or newer, and this is git 2\.22/)
    assert.equal(git.gitProblem('git version 2.50.1 (Apple Git-155)'), undefined)
    assert.equal(git.gitProblem('git version 2.45.1.windows.1'), undefined)
  })
})

describe('rebase with local changes', () => {
  let repo
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  const write = (name, text) => writeFileSync(join(repo, name), text)
  const read = (name) => readFileSync(join(repo, name), 'utf8')

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'ramulus-rebase-'))
    g('init', '-q', '-b', 'main')
    g('config', 'core.autocrlf', 'false')
    g('config', 'user.name', 'Test')
    g('config', 'user.email', 't@example.com')
    write('a.txt', 'one\ntwo\n')
    write('b.txt', 'base\n')
    g('add', '.')
    g('commit', '-qm', 'base')
    g('checkout', '-qb', 'feature')
    write('f.txt', 'feature\n')
    g('add', '.')
    g('commit', '-qm', 'feature work')
    g('checkout', '-q', 'main')
    write('a.txt', 'ONE\ntwo\n')
    g('commit', '-qam', 'main work')
    g('checkout', '-q', 'feature')
  })

  after(() => rmSync(repo, { recursive: true, force: true }))

  it('stashes, rebases, reapplies, and undoes back to the original commit', async () => {
    write('b.txt', 'local edit\n')
    const tip = g('rev-parse', 'HEAD').trim()
    const r = await git.rebase(repo, 'main')
    assert.equal(r.result, 'done')
    assert.equal(r.before, tip)
    assert.equal(read('b.txt'), 'local edit\n')
    assert.equal(read('a.txt'), 'ONE\ntwo\n')
    assert.equal(await git.undoRebase(repo, r.before), 'done')
    assert.equal(g('rev-parse', 'HEAD').trim(), tip)
    assert.equal(read('b.txt'), 'local edit\n')
    assert.equal(g('stash', 'list'), '')
  })

  it('keeps the changes when putting them back conflicts, and undo restores them', async () => {
    write('a.txt', 'mine\ntwo\n')
    const tip = g('rev-parse', 'HEAD').trim()
    const r = await git.rebase(repo, 'main')
    assert.equal(r.result, 'stash-conflicts')
    assert.match(g('stash', 'list'), /autostash/)
    assert.match(read('a.txt'), /<<<<<<<|mine/)
    write('b.txt', 'after rebase\n')
    assert.equal(await git.undoRebase(repo, r.before), 'done')
    assert.equal(g('rev-parse', 'HEAD').trim(), tip)
    assert.equal(read('a.txt'), 'mine\ntwo\n')
    assert.equal(g('stash', 'list', '--format=%gs').trim(), 'On feature: Backup before undoing the rebase')
    assert.equal(g('show', 'stash@{0}:b.txt'), 'after rebase\n')
    g('stash', 'drop', '-q')
  })

  it('refuses to undo once the branch moved after the rebase', async () => {
    g('checkout', '-q', '--', '.')
    const r = await git.rebase(repo, 'main')
    g('rebase', '-q', '--force-rebase', 'main')
    await assert.rejects(git.undoRebase(repo, r.before), /changed after the rebase/)
    write('c.txt', 'later\n')
    g('add', '.')
    g('commit', '-qm', 'later work')
    await assert.rejects(git.undoRebase(repo, r.before), /changed after the rebase/)
  })

  it('stops instead of overwriting an untracked file', async () => {
    g('checkout', '-q', 'main')
    g('rm', '-q', 'b.txt')
    g('commit', '-qm', 'drop b')
    g('checkout', '-q', 'feature')
    const r = await git.rebase(repo, 'main')
    assert.equal(r.result, 'done')
    write('b.txt', 'new work\n')
    write('f.txt', 'tracked edit\n')
    const tip = g('rev-parse', 'HEAD').trim()
    await assert.rejects(git.undoRebase(repo, r.before), /b\.txt/)
    assert.equal(g('rev-parse', 'HEAD').trim(), tip)
    assert.equal(read('b.txt'), 'new work\n')
    assert.equal(read('f.txt'), 'tracked edit\n')
    assert.equal(g('stash', 'list'), '')
  })
})

describe('push when the remote moved on', () => {
  let root
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ramulus-push-'))
    g(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
    g(root, 'clone', '-q', 'remote.git', 'mine')
    writeFileSync(join(root, 'mine', 'a.txt'), 'a\n')
    g(join(root, 'mine'), 'add', '.')
    g(join(root, 'mine'), 'commit', '-qm', 'base')
    g(join(root, 'mine'), 'push', '-q', 'origin', 'main')
    g(root, 'clone', '-q', 'remote.git', 'theirs')
    writeFileSync(join(root, 'theirs', 'b.txt'), 'theirs\n')
    g(join(root, 'theirs'), 'add', '.')
    g(join(root, 'theirs'), 'commit', '-qm', 'their work')
    g(join(root, 'theirs'), 'push', '-q')
    writeFileSync(join(root, 'mine', 'c.txt'), 'mine\n')
    g(join(root, 'mine'), 'add', '.')
    g(join(root, 'mine'), 'commit', '-qm', 'my work')
  })

  after(() => rmSync(root, { recursive: true, force: true }))

  it('reports a rejected push with counts, then force pushes only over the commit it counted', async () => {
    const mine = join(root, 'mine')
    const theirs = join(root, 'theirs')
    const remoteTip = () => g(root, '--git-dir', 'remote.git', 'rev-parse', 'main').trim()
    const r = await git.push(mine)
    assert.deepEqual(r, { result: 'rejected', ahead: 1, behind: 1, theirs: remoteTip() })
    writeFileSync(join(theirs, 'd.txt'), 'more\n')
    g(theirs, 'add', '.')
    g(theirs, 'commit', '-qm', 'their second')
    g(theirs, 'push', '-q')
    g(mine, 'fetch', '-q')
    await assert.rejects(git.push(mine, r.theirs), /stale info|rejected/)
    const again = await git.push(mine)
    assert.equal(again.theirs, remoteTip())
    assert.equal(again.behind, 2)
    assert.deepEqual(await git.push(mine, again.theirs), { result: 'pushed' })
    assert.equal(remoteTip(), g(mine, 'rev-parse', 'HEAD').trim())
  })
})

describe('switching to a remote branch', () => {
  let root
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })
  const mine = () => join(root, 'mine')
  const theirs = () => join(root, 'theirs')
  const read = (f) => readFileSync(join(mine(), f), 'utf8')

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ramulus-remote-'))
    g(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
    g(root, 'clone', '-q', '-c', 'core.autocrlf=false', 'remote.git', 'mine')
    writeFileSync(join(mine(), 'a.txt'), 'one\n')
    writeFileSync(join(mine(), 'b.txt'), 'b\n')
    g(mine(), 'add', '.')
    g(mine(), 'commit', '-qm', 'base')
    g(mine(), 'push', '-q', 'origin', 'main')
    g(mine(), 'switch', '-q', '-c', 'feature')
    g(mine(), 'push', '-q', '-u', 'origin', 'feature')
    g(root, 'clone', '-q', '-c', 'core.autocrlf=false', 'remote.git', 'theirs')
  })

  after(() => rmSync(root, { recursive: true, force: true }))

  const theirCommit = (branch, file, text) => {
    g(theirs(), 'switch', '-q', branch)
    writeFileSync(join(theirs(), file), text)
    g(theirs(), 'commit', '-qam', `edit ${file}`)
    g(theirs(), 'push', '-q', 'origin', branch)
    g(mine(), 'fetch', '-q')
  }

  it('fast-forwards the local branch and keeps uncommitted and staged changes', async () => {
    theirCommit('feature', 'a.txt', 'one\ntwo\n')
    g(mine(), 'switch', '-q', 'main')
    writeFileSync(join(mine(), 'b.txt'), 'b changed\n')
    g(mine(), 'add', 'b.txt')
    assert.deepEqual(await git.checkoutRemote(mine(), 'origin/feature'), { result: 'updated', local: 'feature', ahead: 0, behind: 1, stash: 'kept' })
    assert.equal(g(mine(), 'branch', '--show-current').trim(), 'feature')
    assert.equal(read('a.txt'), 'one\ntwo\n')
    assert.equal(g(mine(), 'status', '--porcelain'), 'M  b.txt\n')
    assert.equal(g(mine(), 'stash', 'list'), '')
    g(mine(), 'reset', '-q', '--hard')
  })

  it('creates a tracking branch when there is no local one', async () => {
    g(theirs(), 'switch', '-q', '-c', 'fresh')
    g(theirs(), 'push', '-q', '-u', 'origin', 'fresh')
    g(mine(), 'fetch', '-q')
    assert.deepEqual(await git.checkoutRemote(mine(), 'origin/fresh'), { result: 'created', local: 'fresh' })
    assert.equal(g(mine(), 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/fresh')
  })

  it('switches without rewriting anything when both sides have commits', async () => {
    g(mine(), 'switch', '-q', 'feature')
    writeFileSync(join(mine(), 'c.txt'), 'mine\n')
    g(mine(), 'add', '.')
    g(mine(), 'commit', '-qm', 'my work')
    const tip = g(mine(), 'rev-parse', 'HEAD').trim()
    theirCommit('feature', 'a.txt', 'one\ntwo\nthree\n')
    g(mine(), 'switch', '-q', 'main')
    assert.equal((await git.checkoutRemote(mine(), 'origin/feature')).result, 'diverged')
    assert.equal(g(mine(), 'rev-parse', 'HEAD').trim(), tip)
  })

  it('puts the changes back when the switch itself fails', async () => {
    g(theirs(), 'switch', '-q', '-c', 'blocked', 'origin/main')
    writeFileSync(join(theirs(), 'c.txt'), 'theirs\n')
    g(theirs(), 'add', '.')
    g(theirs(), 'commit', '-qm', 'add c')
    g(theirs(), 'push', '-q', '-u', 'origin', 'blocked')
    g(mine(), 'fetch', '-q')
    g(mine(), 'switch', '-q', 'main')
    g(mine(), 'reset', '-q', '--hard')
    writeFileSync(join(mine(), 'a.txt'), 'edited\n')
    writeFileSync(join(mine(), 'c.txt'), 'untracked\n')
    await assert.rejects(git.checkoutRemote(mine(), 'origin/blocked'), /untracked|overwritten/i)
    assert.equal(g(mine(), 'branch', '--show-current').trim(), 'main')
    assert.equal(read('a.txt'), 'edited\n')
    assert.equal(read('c.txt'), 'untracked\n')
    assert.equal(g(mine(), 'stash', 'list'), '')
    rmSync(join(mine(), 'c.txt'))
    g(mine(), 'reset', '-q', '--hard')
  })

  it('keeps the changes in the stash when putting them back conflicts', async () => {
    g(mine(), 'switch', '-q', 'main')
    theirCommit('main', 'b.txt', 'theirs\n')
    g(mine(), 'reset', '-q', '--hard', 'HEAD')
    writeFileSync(join(mine(), 'b.txt'), 'mine\n')
    const r = await git.checkoutRemote(mine(), 'origin/main')
    assert.equal(r.result, 'updated')
    assert.equal(r.stash, 'conflicts')
    assert.match(g(mine(), 'stash', 'list'), /autostash/)
    assert.match(read('b.txt'), /<<<<<<<|mine/)
  })
})

describe('deleting a branch on its remote', () => {
  let root
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ramulus-delremote-'))
    g(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
    g(root, 'clone', '-q', 'remote.git', 'mine')
    writeFileSync(join(root, 'mine', 'a.txt'), 'a\n')
    g(join(root, 'mine'), 'add', '.')
    g(join(root, 'mine'), 'commit', '-qm', 'base')
    g(join(root, 'mine'), 'push', '-q', 'origin', 'main', 'main:feat/done')
    g(join(root, 'mine'), 'fetch', '-q')
  })

  after(() => rmSync(root, { recursive: true, force: true }))

  it('pushes the deletion to the remote the name starts with, and refuses names of no remote', async () => {
    const mine = join(root, 'mine')
    await git.deleteRemoteBranch(mine, 'origin/feat/done')
    assert.equal(g(root, '--git-dir', 'remote.git', 'branch', '--list', 'feat/done'), '')
    assert.equal(g(mine, 'branch', '-r', '--list', 'origin/feat/done'), '')
    await assert.rejects(git.deleteRemoteBranch(mine, 'elsewhere/main'), /No remote has the branch/)
    await assert.rejects(git.deleteRemoteBranch(mine, 'origin/-f'), /Invalid name/)
  })
})
