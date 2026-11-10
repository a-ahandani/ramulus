import { describe, expect, it } from 'vitest'
import { ago, cannotFastForward, ciByCommit, ciState, dropAt, finished, moved, githubOwner, mergedBranches, prsByBranch, sessionMeta, settleLimited, termTitle, tokenCount, webUrl, wipTally, openTab } from './bits'

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

describe('openTab', () => {
  it('puts a newly opened file in place of the untouched one, and keeps the rest', () => {
    const kept = { key: 'a' }
    const peek = { key: 'b', preview: true }
    const next = { key: 'c', preview: true }
    expect(openTab([peek, kept], next)).toEqual([next, kept])
    expect(openTab([kept], next)).toEqual([kept, next])
    // a PR or Review tab never replaces anything
    expect(openTab([kept, peek], { key: 'pr' })).toEqual([kept, peek, { key: 'pr' }])
    const ts = [kept, peek]
    expect(openTab(ts, { key: 'a', preview: true })).toBe(ts)
  })
})

describe('webUrl', () => {
  it('keeps web addresses and drops anything that could run code', () => {
    expect(webUrl('https://github.com/o/r/actions/runs/1')).toBe('https://github.com/o/r/actions/runs/1')
    expect(webUrl('HTTP://ci.example/log')).toBe('HTTP://ci.example/log')
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example', '']) expect(webUrl(bad)).toBeUndefined()
  })
})

describe('githubOwner', () => {
  it('reads the owner from https, ssh and scp-style GitHub remotes only', () => {
    expect(githubOwner('https://github.com/a-ahandani/ramulus.git')).toBe('a-ahandani')
    expect(githubOwner('https://user:token@github.com/Org/repo')).toBe('Org')
    expect(githubOwner('git@github.com:anthropics/claude-code.git')).toBe('anthropics')
    expect(githubOwner('ssh://git@github.com/org/repo.git')).toBe('org')
    for (const other of ['https://gitlab.com/o/r.git', 'https://github.com.evil.example/o/r', 'https://notgithub.com/o/r', 'git@github.com:o', '', undefined]) expect(githubOwner(other)).toBeUndefined()
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

describe('wipTally', () => {
  it('counts each file once, by its change against the last commit', () => {
    const tally = wipTally({
      staged: [
        { path: 'new.ts', kind: 'A' },
        { path: 'gone.ts', kind: 'M' },
        { path: 'edit.ts', kind: 'M' },
      ],
      unstaged: [
        { path: 'new.ts', kind: 'M' },
        { path: 'gone.ts', kind: 'D' },
        { path: 'edit.ts', kind: 'M' },
        { path: 'untracked.ts', kind: '?' },
      ],
    })
    expect(tally).toEqual({ M: 1, A: 2, D: 1 })
  })
})

describe('agent conversation stats', () => {
  it('shortens token counts', () => {
    expect([950, 1234, 163002, 999700, 2809339, 12_400_000].map(tokenCount)).toEqual(['950', '1.2K', '163K', '1.0M', '2.8M', '12M'])
  })

  it('says what each agent records, and nothing it does not', () => {
    const time = Date.now() - 2 * 3600_000
    expect(sessionMeta({ agent: 'claude', id: 'a', title: 't', time, context: 163002, cost: 19.413 }, 'Claude Code')).toBe('Claude Code · 163K context · $19.41 · 2h')
    expect(sessionMeta({ agent: 'codex', id: 'b', title: 't', time, context: 117032, window: 258400, tokens: 2809339 }, 'Codex')).toBe('Codex · 117K / 258K context · 2.8M tokens · 2h')
    expect(sessionMeta({ agent: 'opencode', id: 'c', title: 't', time, cost: 0 }, 'opencode')).toBe('opencode · 2h')
  })
})

describe('reordering', () => {
  it('moves one item and keeps the rest in order', () => {
    expect(moved(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moved(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
    expect(moved(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
  })
  it('drops a dragged item past the middles it has passed', () => {
    const mids = [10, 30, 50]
    expect(dropAt(mids, 0, 10)).toBe(0)
    expect(dropAt(mids, 0, 35)).toBe(1)
    expect(dropAt(mids, 0, 99)).toBe(2)
    expect(dropAt(mids, 2, 25)).toBe(1)
    expect(dropAt(mids, 2, -5)).toBe(0)
  })
})
