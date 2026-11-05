import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { MergeMethod, ResetMode } from '../git/backend'
import type { NetSettings } from '../git/repo'
import { loadScheme, type Scheme } from '../git/scheme'
import { Icon } from './bits'

export type Dialog =
  | { kind: 'branch'; at: string; name?: string }
  | { kind: 'tag'; at: string }
  | { kind: 'rename'; old: string }
  | { kind: 'stash' }
  | { kind: 'reset'; at: string }
  | { kind: 'confirm'; message: string; action: () => void }
  | { kind: 'error'; title: string; message: string }
  | { kind: 'settings' }
  /** the branch and its remote both have commits the other lacks, found by a refused push or a pull that cannot fast-forward */
  | { kind: 'diverged'; branch: string; ahead?: number; behind?: number; push: boolean; rebase: () => void; merge: () => void; force?: () => void }
  | { kind: 'cleanup'; branches: { name: string; pr: number; remote?: string }[]; run: (local: string[], remote: string[]) => void }
  | { kind: 'repos'; folder: string; inside?: boolean; repos: { dir: string; name: string }[]; open: (dirs: string[]) => void }
  | { kind: 'scheme' }
  | { kind: 'pr-merge'; number: number; title: string; last: MergeMethod; merge: (method: MergeMethod) => void }

const MERGE_OPTIONS: [MergeMethod, string, string][] = [
  ['merge', 'Create a merge commit', 'Keeps every commit and adds a merge commit on top.'],
  ['squash', 'Squash and merge', 'Combines all commits into one.'],
  ['rebase', 'Rebase and merge', 'Replays each commit on the base branch, no merge commit.'],
]

export interface DialogProps {
  dialog: Dialog
  settings: NetSettings
  native: boolean
  onClose: () => void
  onCreateBranch: (name: string, at: string, checkout: boolean) => void
  onCreateTag: (name: string, at: string, message: string) => void
  onRename: (old: string, name: string) => void
  onStash: (message: string) => void
  onReset: (at: string, mode: ResetMode) => void
  onSettings: (s: NetSettings) => void
  onSuggestBranch?: (at: string) => void
  suggesting?: boolean
  onScheme?: (scheme: Scheme) => void
}

function validRef(name: string): boolean {
  return name.length > 0 && !name.startsWith('-') && !/[\s~^:?*[\\]|\.\.|@\{|\/$|\.$|^\/|\/\/|\.lock$/.test(name) && name !== '@'
}

export function Frame({ title, children, onClose, cls = '' }: { title: string; children: ComponentChildren; onClose: () => void; cls?: string }) {
  return (
    <div class={`overlay ${cls}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="dialog" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

export function Buttons({ ok, danger, enabled, onOk, onClose }: { ok: string; danger?: boolean; enabled: boolean; onOk: () => void; onClose: () => void }) {
  return (
    <div class="buttons">
      <button onClick={onClose}>Cancel</button>
      <button class={danger ? 'danger' : 'primary'} disabled={!enabled} onClick={onOk}>
        {ok}
      </button>
    </div>
  )
}

export function Dialogs(p: DialogProps) {
  const d = p.dialog
  const [name, setName] = useState(d.kind === 'rename' ? d.old : '')
  const [message, setMessage] = useState('')
  const [checkout, setCheckout] = useState(true)
  const [picked, setPicked] = useState<Set<string>>(() => new Set(d.kind === 'repos' ? d.repos.map((r) => r.dir) : d.kind === 'cleanup' ? d.branches.map((b) => b.name) : []))
  const [alsoRemote, setAlsoRemote] = useState(false)
  const [net, setNet] = useState(p.settings)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const first = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    first.current?.focus()
    return () => {
      alive.current = false
    }
  }, [])
  const suggested = d.kind === 'branch' ? d.name : undefined
  useEffect(() => {
    if (suggested) setName(suggested)
  }, [suggested])
  const submit = (enabled: boolean, fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' && enabled && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault()
      fn()
      p.onClose()
    }
  }
  switch (d.kind) {
    case 'branch': {
      const ok = validRef(name)
      const go = () => p.onCreateBranch(name, d.at, checkout)
      return (
        <Frame title="Name the new branch" onClose={p.onClose}>
          <div class="input-row">
            <input ref={first} placeholder="branch name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={submit(ok, go)} />
            {p.onSuggestBranch && (
              <button
                class={`icon ${p.suggesting ? 'spin' : ''}`}
                title={p.suggesting ? 'Suggesting. Click to stop' : 'Suggest a name with your AI agent'}
                aria-label={p.suggesting ? 'Stop suggesting' : 'Suggest a name with your AI agent'}
                onClick={() => p.onSuggestBranch!(d.at)}
              >
                <Icon name={p.suggesting ? 'loading' : 'sparkle'} />
              </button>
            )}
          </div>
          <label>
            <input type="checkbox" checked={checkout} onChange={(e) => setCheckout((e.target as HTMLInputElement).checked)} /> Switch to it right away
          </label>
          {name && !ok && <div class="error">That is not a valid branch name</div>}
          <Buttons ok="Create" enabled={ok} onOk={() => (go(), p.onClose())} onClose={p.onClose} />
        </Frame>
      )
    }
    case 'tag': {
      const ok = validRef(name)
      const go = () => p.onCreateTag(name, d.at, message)
      return (
        <Frame title="Name the new tag" onClose={p.onClose}>
          <input ref={first} placeholder="tag name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={submit(ok, go)} />
          <textarea placeholder="Message for an annotated tag (optional)" value={message} onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)} />
          {name && !ok && <div class="error">That is not a valid tag name</div>}
          <Buttons ok="Create" enabled={ok} onOk={() => (go(), p.onClose())} onClose={p.onClose} />
        </Frame>
      )
    }
    case 'rename': {
      const ok = validRef(name) && name !== d.old
      const go = () => p.onRename(d.old, name)
      return (
        <Frame title={`Rename '${d.old}' to`} onClose={p.onClose}>
          <input ref={first} placeholder="new name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={submit(ok, go)} />
          <Buttons ok="Rename" enabled={ok} onOk={() => (go(), p.onClose())} onClose={p.onClose} />
        </Frame>
      )
    }
    case 'stash': {
      const go = () => p.onStash(message)
      return (
        <Frame title="Stash everything" onClose={p.onClose}>
          <input ref={first} placeholder="Short note for this stash" value={message} onInput={(e) => setMessage((e.target as HTMLInputElement).value)} onKeyDown={submit(true, go)} />
          <Buttons ok="Stash" enabled={true} onOk={() => (go(), p.onClose())} onClose={p.onClose} />
        </Frame>
      )
    }
    case 'reset':
      return (
        <Frame title={`Reset the branch to ${d.at.slice(0, 7)}`} onClose={p.onClose}>
          <button onClick={() => (p.onReset(d.at, 'soft'), p.onClose())}>Soft: keep everything staged and in the working tree</button>
          {p.native && <button onClick={() => (p.onReset(d.at, 'mixed'), p.onClose())}>Mixed: keep the working tree, clear the index</button>}
          <button class="danger" onClick={() => (p.onReset(d.at, 'hard'), p.onClose())}>
            Hard: drop the index and the working tree
          </button>
          <div class="buttons">
            <button onClick={p.onClose}>Cancel</button>
          </div>
        </Frame>
      )
    case 'pr-merge': {
      const ordered = [...MERGE_OPTIONS.filter((o) => o[0] === d.last), ...MERGE_OPTIONS.filter((o) => o[0] !== d.last)]
      return (
        <Frame title={`Merge #${d.number} on GitHub`} onClose={p.onClose}>
          <div>{d.title}</div>
          {ordered.map(([method, label, hint], i) => (
            <button key={method} class={`choice ${i === 0 ? 'primary' : ''}`} onClick={() => (d.merge(method), p.onClose())}>
              <b>{label}</b>
              <span>{hint}</span>
            </button>
          ))}
          <div class="buttons">
            <button onClick={p.onClose}>Cancel</button>
          </div>
        </Frame>
      )
    }
    case 'confirm':
      return (
        <Frame title="Please confirm" onClose={p.onClose}>
          <div>{d.message}</div>
          <Buttons ok="Yes" danger enabled={true} onOk={() => (d.action(), p.onClose())} onClose={p.onClose} />
        </Frame>
      )
    case 'repos': {
      const q = query.trim().toLowerCase()
      const shown = d.repos.filter((r) => !q || r.name.toLowerCase().includes(q) || r.dir.slice(d.folder.length).toLowerCase().includes(q))
      const chosen = (q ? shown : d.repos).filter((r) => picked.has(r.dir))
      const n = chosen.length
      const go = () => n > 0 && (d.open(chosen.map((r) => r.dir)), p.onClose())
      const setAll = (on: boolean) =>
        setPicked((s) => {
          const next = new Set(s)
          for (const r of shown) {
            if (on) next.add(r.dir)
            else next.delete(r.dir)
          }
          return next
        })
      return (
        <Frame title={d.inside ? 'Open the repositories inside this one?' : 'Open the repositories in this folder?'} onClose={p.onClose}>
          <div>
            {d.inside ? (
              <>
                <code>{d.folder}</code> has {d.repos.length === 1 ? 'another repository' : `${d.repos.length} more repositories`} in its subfolders. Each one you pick opens in the sidebar next to it.
              </>
            ) : (
              <>
                <code>{d.folder}</code> is not a git repository. It has {d.repos.length === 1 ? 'one repository' : `${d.repos.length} repositories`} inside, and each one you pick opens in the sidebar.
              </>
            )}
          </div>
          {d.repos.length > 1 && (
            <div class="input-row">
              <input
                ref={first}
                placeholder="Filter repositories"
                aria-label="Filter repositories"
                value={query}
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  go()
                }}
              />
              <button onClick={() => setAll(true)} disabled={shown.every((r) => picked.has(r.dir))}>
                Select all
              </button>
              <button onClick={() => setAll(false)} disabled={!shown.some((r) => picked.has(r.dir))}>
                Select none
              </button>
            </div>
          )}
          <div class="repo-list">
            {shown.map((r, i) => (
              <label key={r.dir} title={r.dir}>
                <input
                  ref={i === 0 && d.repos.length === 1 ? first : undefined}
                  type="checkbox"
                  checked={picked.has(r.dir)}
                  onChange={() =>
                    setPicked((s) => {
                      const next = new Set(s)
                      if (next.has(r.dir)) next.delete(r.dir)
                      else next.add(r.dir)
                      return next
                    })
                  }
                />
                {r.name}
                <span class="path">{r.dir.slice(d.folder.length).replace(/^[/\\]/, '')}</span>
              </label>
            ))}
            {shown.length === 0 && <div class="hint">No repository matches “{query.trim()}”</div>}
          </div>
          <div class="hint">
            {n} of {q ? `${shown.length} shown` : d.repos.length} selected
          </div>
          <Buttons ok={n === 1 ? 'Open 1 repository' : `Open ${n} repositories`} enabled={n > 0} onOk={go} onClose={p.onClose} />
        </Frame>
      )
    }
    case 'scheme': {
      const go = async () => {
        if (!name.trim() || busy) return
        setBusy(true)
        setError('')
        try {
          const scheme = await loadScheme(name)
          if (!alive.current) return
          p.onScheme!(scheme)
          p.onClose()
        } catch (e) {
          if (alive.current) setError(e instanceof Error ? e.message : String(e))
        } finally {
          if (alive.current) setBusy(false)
        }
      }
      return (
        <Frame title="Use a color scheme" onClose={p.onClose}>
          <div>
            Pick a theme on{' '}
            <a href="https://terminalcolors.com/" target="_blank" rel="noreferrer">
              terminalcolors.com
            </a>{' '}
            and paste its link.
          </div>
          <input
            ref={first}
            placeholder="https://terminalcolors.com/themes/catppuccin/mocha/"
            aria-label="Theme link"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              go()
            }}
          />
          {error && <div class="error">{error}</div>}
          <Buttons ok={busy ? 'Loading…' : 'Use it'} enabled={!!name.trim() && !busy} onOk={go} onClose={p.onClose} />
        </Frame>
      )
    }
    case 'diverged': {
      const n = (k: number) => `${k} commit${k === 1 ? '' : 's'}`
      const counted = d.ahead !== undefined && d.behind !== undefined
      const then = d.push ? ', then push' : ''
      return (
        <Frame title="The remote has commits you don't have" onClose={p.onClose}>
          <div>
            {counted ? `${d.branch} is ${n(d.behind!)} ahead of you on the remote, and you have ${n(d.ahead!)} it lacks.` : `${d.branch} has new commits both here and on the remote, so it cannot simply fast-forward.`}
          </div>
          <button class="choice" onClick={() => (p.onClose(), d.rebase())}>
            <b>Rebase onto theirs{then}</b>
            <span>{counted ? `Your ${n(d.ahead!)}` : 'Your commits'} on top of theirs. Recommended.</span>
          </button>
          <button class="choice" onClick={() => (p.onClose(), d.merge())}>
            <b>Merge theirs{then}</b>
            <span>A merge commit joins both sides.</span>
          </button>
          {d.force && (
            <button class="choice danger" onClick={() => (p.onClose(), d.force!())}>
              <b>Force push</b>
              <span>Drops their {n(d.behind ?? 0)}. Stops if the remote moves again.</span>
            </button>
          )}
          <div class="buttons">
            <button onClick={p.onClose}>Cancel</button>
          </div>
        </Frame>
      )
    }
    case 'cleanup': {
      const chosen = d.branches.filter((b) => picked.has(b.name))
      const remote = chosen.flatMap((b) => (b.remote ? [b.remote] : []))
      const n = chosen.length
      return (
        <Frame title="Delete the merged branches?" onClose={p.onClose}>
          <div>Each of these points at exactly the commit its pull request merged, so nothing is lost.</div>
          <div class="repo-list">
            {d.branches.map((b) => (
              <label key={b.name}>
                <input
                  type="checkbox"
                  checked={picked.has(b.name)}
                  onChange={() =>
                    setPicked((s) => {
                      const next = new Set(s)
                      if (next.has(b.name)) next.delete(b.name)
                      else next.add(b.name)
                      return next
                    })
                  }
                />
                {b.name}
                <span class="path">#{b.pr}</span>
              </label>
            ))}
          </div>
          {d.branches.some((b) => b.remote) && (
            <label>
              <input type="checkbox" checked={alsoRemote} onChange={(e) => setAlsoRemote((e.target as HTMLInputElement).checked)} /> Also delete {remote.length === 1 ? 'it' : 'them'} on the remote ({remote.length})
            </label>
          )}
          <Buttons ok={n === 1 ? 'Delete 1 branch' : `Delete ${n} branches`} danger enabled={n > 0} onOk={() => (d.run(chosen.map((b) => b.name), alsoRemote ? remote : []), p.onClose())} onClose={p.onClose} />
        </Frame>
      )
    }
    case 'error':
      return (
        <Frame title={d.title} onClose={p.onClose}>
          <pre>{d.message}</pre>
          <div class="buttons">
            <button class="primary" onClick={p.onClose}>
              OK
            </button>
          </div>
        </Frame>
      )
    case 'settings':
      return (
        <Frame title="Settings" onClose={p.onClose}>
          <div class="label">Your name and email for commits (used when the repository has no user.name)</div>
          <input ref={first} placeholder="Name" value={net.authorName} onInput={(e) => setNet({ ...net, authorName: (e.target as HTMLInputElement).value })} />
          <input placeholder="Email" value={net.authorEmail} onInput={(e) => setNet({ ...net, authorEmail: (e.target as HTMLInputElement).value })} />
          <div class="label">CORS proxy, required for fetch, pull and push (git hosts block direct browser requests)</div>
          <input placeholder="https://your-proxy.example.com" value={net.corsProxy} onInput={(e) => setNet({ ...net, corsProxy: (e.target as HTMLInputElement).value })} />
          <div class="label">Username (optional, defaults to a token login)</div>
          <input value={net.username} onInput={(e) => setNet({ ...net, username: (e.target as HTMLInputElement).value })} />
          <div class="label">Personal access token (kept only until this tab closes)</div>
          <input type="password" value={net.token} onInput={(e) => setNet({ ...net, token: (e.target as HTMLInputElement).value })} />
          <Buttons ok="Save" enabled={true} onOk={() => (p.onSettings(net), p.onClose())} onClose={p.onClose} />
        </Frame>
      )
  }
}
