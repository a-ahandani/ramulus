import { describe, expect, it } from 'vitest'
import { ago, cannotFastForward, ciByCommit, ciState, finished, mergedBranches, prsByBranch, settleLimited, termTitle, webUrl } from './bits'

describe('settleLimited', () => {
  it('never runs more than the limit at once and keeps results in order', async () => {
    let running = 0
    let peak = 0
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      if (i === 4) throw new Error('boom')
      return i
    })
    const seen: number[] = []
    const results = await settleLimited(tasks, 3, (done) => seen.push(done))
    expect(peak).toBe(3)
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : 'failed'))).toEqual([0, 1, 2, 3, 'failed', 5, 6, 7, 8, 9])
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

describe('prsByBranch', () => {
  it('keeps the newest pull request per branch, but an open one wins over a merged one', () => {
    const pr = (number: number, branch: string, state: 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED') => ({ number, title: '', url: '', branch, state })
    const map = prsByBranch([pr(9, 'a', 'MERGED'), pr(8, 'a', 'OPEN'), pr(7, 'b', 'CLOSED'), pr(6, 'b', 'MERGED'), pr(5, 'c', 'DRAFT')])
    expect([...map].map(([b, x]) => `${b}:${x.number}`)).toEqual(['a:8', 'b:7', 'c:5'])
  })
})

describe('ago', () => {
  it('says minutes, hours and days, long or compact', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(ago(now - 20)).toBe('just now')
    expect(ago(now - 12 * 60)).toBe('12 minutes ago')
    expect(ago(now - 3 * 3600, true)).toBe('3h')
    expect(ago(now - 2 * 86400, true)).toBe('2d')
    expect(ago(now - 20, true)).toBe('now')
  })
})

describe('webUrl', () => {
  it('keeps web addresses and drops anything that could run code', () => {
    expect(webUrl('https://github.com/o/r/actions/runs/1')).toBe('https://github.com/o/r/actions/runs/1')
    expect(webUrl('HTTP://ci.example/log')).toBe('HTTP://ci.example/log')
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example', '']) expect(webUrl(bad)).toBeUndefined()
  })
})

describe('termTitle', () => {
  it('shows the topic Claude Code gives its terminal and whether it is working', () => {
    expect(termTitle({ id: 'a', kind: 'agent', agent: 'claude', title: '\u2733 Fix the login' })).toEqual({ label: 'Fix the login', busy: false })
    expect(termTitle({ id: 'a', kind: 'agent', agent: 'claude', title: '\u25d0 Fix the login' })).toEqual({ label: 'Fix the login', busy: true })
    expect(termTitle({ id: 'a', kind: 'agent', agent: 'claude' })).toEqual({ label: 'Claude Code', busy: false })
    expect(termTitle({ id: 's', kind: 'shell', title: '~ dir' })).toEqual({ label: '~ dir', busy: false })
    expect(termTitle({ id: 's', kind: 'shell' })).toEqual({ label: 'Terminal', busy: false })
  })
})

describe('finished', () => {
  it('names the Claude tabs that went from working to idle, and nothing else', () => {
    const tab = (id: string, title?: string, kind: 'agent' | 'shell' = 'agent') => ({ id, kind, agent: kind === 'agent' ? 'claude' : undefined, title })
    const before = [tab('a', '\u2802 Fix login'), tab('b', '\u2802 Tests'), tab('c', '\u2733 Idle'), tab('d', 'zsh', 'shell')]
    const after = [tab('a', '\u2733 Fix login'), tab('b', '\u2804 Tests'), tab('c', '\u2733 Idle'), tab('d', 'vim', 'shell')]
    expect(finished(before, after)).toEqual(['a'])
    expect(finished(before, [])).toEqual([])
  })
})

describe('mergedBranches', () => {
  const pr = (branch: string, state: 'OPEN' | 'MERGED', oid?: string) => ({ number: 1, title: '', url: '', branch, state, oid })
  it('keeps only branches still at the commit their merged pull request merged, never a branch others merge into', () => {
    const prs = prsByBranch([pr('done', 'MERGED', 'aaa'), pr('moved', 'MERGED', 'bbb'), pr('open', 'OPEN', 'ccc'), pr('here', 'MERGED', 'ddd'), pr('old-gh', 'MERGED'), pr('develop', 'MERGED', 'ggg'), { ...pr('feature', 'OPEN'), base: 'develop' }])
    const branches = [
      { name: 'done', oid: 'aaa', isHead: false },
      { name: 'moved', oid: 'new', isHead: false },
      { name: 'open', oid: 'ccc', isHead: false },
      { name: 'here', oid: 'ddd', isHead: true },
      { name: 'old-gh', oid: 'eee', isHead: false },
      { name: 'no-pr', oid: 'fff', isHead: false },
      { name: 'develop', oid: 'ggg', isHead: false },
    ]
    expect(mergedBranches(branches, prs).map((b) => b.name)).toEqual(['done'])
  })
})

describe('cannotFastForward', () => {
  it("recognises git's refusal in old and new wording", () => {
    expect(cannotFastForward(new Error('fatal: Not possible to fast-forward, aborting.'))).toBe(true)
    expect(cannotFastForward('hint: Diverging branches can\'t be fast-forwarded')).toBe(true)
    expect(cannotFastForward(new Error('fatal: could not read from remote'))).toBe(false)
  })
})

describe('ciState', () => {
  it('shows a failure first, then a run still going, then a pass, per commit', () => {
    const run = (sha: string, state: 'pass' | 'fail' | 'running' | 'cancelled' | 'skipped') => ({ sha, workflow: state, state, url: '' })
    const by = ciByCommit([run('a', 'pass'), run('a', 'running'), run('b', 'pass'), run('b', 'fail'), run('b', 'running'), run('c', 'skipped'), run('c', 'pass')])
    expect([...by.keys()]).toEqual(['a', 'b', 'c'])
    expect(['a', 'b', 'c', 'none'].map((sha) => ciState(by.get(sha)))).toEqual(['running', 'fail', 'pass', undefined])
  })
})
