import { useEffect, useState } from 'preact/hooks'
import type { AgentSession, CheckState, CiRun, PullRequest, TermTab } from '../git/backend'
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

// the agents' own marks, from Lobe Icons (MIT License, LobeHub), in the text's color
const LOGOS: Record<string, { d: string; evenodd?: boolean }> = {
  claude: { d: 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z' },
  codex: { d: 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z', evenodd: true },
  opencode: { d: 'M16 6H8v12h8V6zm4 16H4V2h16v20z', evenodd: true },
  gemini: { d: 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z' },
}

/** The agent's logo, or a sparkle for one without. */
export function AgentLogo({ agent }: { agent?: string }) {
  const logo = agent ? LOGOS[agent] : undefined
  if (!logo) return <Icon name="sparkle" />
  return (
    <svg class="agent-logo" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d={logo.d} fill="currentColor" fill-rule={logo.evenodd ? 'evenodd' : undefined} />
    </svg>
  )
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

/** A token count short enough for a list: 950, 1.2K, 163K, 2.8M. */
export function tokenCount(n: number): string {
  const k = n / 1e3
  const m = n / 1e6
  return n < 1e3 ? `${n}` : k < 9.95 ? `${k.toFixed(1)}K` : k < 999.5 ? `${Math.round(k)}K` : m < 9.95 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`
}

/** What a History row says after the title: the agent, how full its context was, what it used, and when. */
export function sessionMeta(s: AgentSession, agentName: string): string {
  const context = s.context && (s.window ? `${tokenCount(s.context)} / ${tokenCount(s.window)} context` : `${tokenCount(s.context)} context`)
  const cost = s.cost !== undefined && s.cost >= 0.01 && `$${s.cost.toFixed(2)}`
  return [agentName, context, s.tokens && `${tokenCount(s.tokens)} tokens`, cost, ago(Math.floor(s.time / 1000), true)].filter(Boolean).join(' · ')
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

/** the GitHub user or organization that owns a remote, from an https, ssh or scp-style URL */
export const githubOwner = (url = '') => /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com[:/]([a-z0-9-]+)\//i.exec(url)?.[1]

/** the repository owner's GitHub avatar, or the Ramulus mark when origin is not on GitHub or the avatar does not load */
export function RepoMark({ url }: { url?: string }) {
  const owner = githubOwner(url)
  const [failed, setFailed] = useState<string>()
  if (!owner || failed === owner) return <BrandMark />
  return <img class="repo-mark" src={`https://github.com/${owner}.png?size=64`} alt="" title={owner} onError={() => setFailed(owner)} />
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
