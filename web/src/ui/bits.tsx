import { useEffect, useState } from 'preact/hooks'
import type { CheckState, CiRun, PullRequest, TermTab } from '../git/backend'
import type { BranchInfo, ChangeKind, WorkStatus } from '../git/repo'

export const LANES = 10

export const stored = (key: string) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(key))
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function Laptop() {
  return (
    <svg class="codicon laptop" width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
      <rect x="3" y="3.5" width="10" height="7" rx="1" />
      <path d="M1.5 12.5h13" stroke-linecap="round" />
    </svg>
  )
}

/** Uncommitted files by kind, one kind per file: a file staged as added and edited again still counts as added. */
export function wipTally(s: WorkStatus) {
  const kinds = new Map<string, ChangeKind>()
  for (const f of [...s.staged, ...s.unstaged]) if ((kinds.get(f.path) ?? 'M') === 'M') kinds.set(f.path, f.kind)
  const tally = { M: 0, A: 0, D: 0 }
  for (const k of kinds.values()) tally[k === '?' ? 'A' : k]++
  return tally
}

export function Icon({ name }: { name: string }) {
  return <i class={`codicon codicon-${name}`} aria-hidden="true" />
}

export async function settleLimited<T>(tasks: (() => Promise<T>)[], limit: number, onSettled: (done: number) => void): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = []
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]().then(
        (value) => ({ status: 'fulfilled', value }) as const,
        (reason) => ({ status: 'rejected', reason }) as const,
      )
      onSettled(++done)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'opencode' }

/** A terminal tab's label. Claude Code titles its terminal "✳ topic" when idle and puts a spinner glyph before the topic while it works. */
export function termTitle(t: TermTab): { label: string; busy: boolean } {
  const name = t.kind === 'shell' ? 'Terminal' : (AGENT_NAMES[t.agent ?? ''] ?? t.agent ?? 'Agent')
  const m = t.agent === 'claude' && t.title ? /^(\S)\s+(.+)$/u.exec(t.title) : null
  if (m && !/[\p{L}\p{N}]/u.test(m[1])) return { label: m[2], busy: m[1] !== '\u2733' }
  return { label: t.title || name, busy: false }
}

export const webUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined)

export const PR_ICON = { OPEN: 'git-pull-request', DRAFT: 'git-pull-request-draft', MERGED: 'git-merge', CLOSED: 'git-pull-request-closed' }

export function prsByBranch(list: PullRequest[]): Map<string, PullRequest> {
  const open = (pr?: PullRequest) => pr?.state === 'OPEN' || pr?.state === 'DRAFT'
  const out = new Map<string, PullRequest>()
  for (const pr of list) if (!out.has(pr.branch) || (open(pr) && !open(out.get(pr.branch)))) out.set(pr.branch, pr)
  return out
}

/** the runs of each commit */
export function ciByCommit(runs: CiRun[]): Map<string, CiRun[]> {
  const out = new Map<string, CiRun[]>()
  for (const r of runs) out.set(r.sha, [...(out.get(r.sha) ?? []), r])
  return out
}

/** one state for a commit's runs: a failure outweighs a run still going, which outweighs a pass */
export function ciState(runs: CiRun[] = []): CheckState | undefined {
  return (['fail', 'running', 'pass', 'cancelled', 'skipped'] as const).find((s) => runs.some((r) => r.state === s))
}

export const CI_ICON: Record<CheckState, string> = { pass: 'pass-filled', fail: 'error', running: 'loading', cancelled: 'circle-slash', skipped: 'circle-slash' }
export const CI_WORD: Record<CheckState, string> = { pass: 'passed', fail: 'failed', running: 'running', cancelled: 'cancelled', skipped: 'skipped' }

/** the agent tabs that were working before and are idle now */
export function finished(before: TermTab[], after: TermTab[]): string[] {
  const was = new Set(before.filter((t) => termTitle(t).busy).map((t) => t.id))
  return after.filter((t) => was.has(t.id) && !termTitle(t).busy).map((t) => t.id)
}

/** git's refusal to fast-forward a branch that has commits of its own */
export const cannotFastForward = (e: unknown) => /Not possible to fast-forward|Diverging branches/i.test(e instanceof Error ? e.message : String(e))

/**
 * Branches still pointing at exactly the commit their merged pull request merged, so deleting them loses nothing.
 * A branch that pull requests merge into, such as develop after a release, is long-lived and never offered.
 */
export function mergedBranches(branches: BranchInfo[], prs: Map<string, PullRequest>): BranchInfo[] {
  const bases = new Set([...prs.values()].map((pr) => pr.base))
  return branches.filter((b) => {
    const pr = prs.get(b.name)
    return !b.isHead && !bases.has(b.name) && pr?.state === 'MERGED' && !!pr.oid && pr.oid === b.oid
  })
}

export function BrandMark() {
  return <span class="brand-mark" aria-hidden="true" />
}

export function BrandLinks() {
  return (
    <>
      <span class="sep" />
      <a class="tb-link" href="https://a-ahandani.github.io/ramulus/" target="_blank" rel="noreferrer" title="Ramulus website" aria-label="Ramulus website">
        <Icon name="globe" />
      </a>
      <a class="tb-link" href="https://github.com/a-ahandani/ramulus" target="_blank" rel="noreferrer" title="Ramulus on GitHub" aria-label="Ramulus on GitHub">
        <Icon name="github" />
      </a>
    </>
  )
}

export function laneColor(col: number): string {
  return `var(--lane-${col % LANES})`
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  const a = parts[0]?.[0] ?? '?'
  const b = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (a + b).toUpperCase()
}

export function short(oid: string): string {
  return oid.slice(0, 7)
}

export function fmtDate(t: number): string {
  return new Date(t * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function ago(t: number, compact = false): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t)
  const units: [number, string, string][] = [
    [365 * 86400, 'year', 'y'],
    [30 * 86400, 'month', 'mo'],
    [7 * 86400, 'week', 'w'],
    [86400, 'day', 'd'],
    [3600, 'hour', 'h'],
    [60, 'minute', 'm'],
  ]
  for (const [len, name, short] of units) {
    if (s >= len) {
      const n = Math.floor(s / len)
      return compact ? `${n}${short}` : `${n} ${name}${n === 1 ? '' : 's'} ago`
    }
  }
  return compact ? 'now' : 'just now'
}

const hashes = new Map<string, string>()

async function emailHash(email: string): Promise<string> {
  const key = email.trim().toLowerCase()
  const hit = hashes.get(key)
  if (hit) return hit
  const data = new TextEncoder().encode(key)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  hashes.set(key, hex)
  return hex
}

export function Avatar({ name, email, color, size = 20 }: { name: string; email: string; color: string; size?: number }) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setFailed(false)
    if (!email || !crypto.subtle) {
      setUrl(undefined)
      return
    }
    emailHash(email).then((h) => live && setUrl(`https://www.gravatar.com/avatar/${h}?s=64&d=404`))
    return () => {
      live = false
    }
  }, [email])
  const photo = !!url && !failed
  const letters = size < 20 ? initials(name).slice(0, 1) : initials(name)
  return (
    <span class="avatar" style={{ '--c': color, width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * (letters.length > 1 ? 0.4 : 0.5))}px` }} title={name}>
      {photo ? <img src={url} alt="" onError={() => setFailed(true)} /> : letters}
    </span>
  )
}
