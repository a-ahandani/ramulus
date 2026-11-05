import { useEffect, useRef, useState } from 'preact/hooks'
import { DEFAULT_PROMPTS, fillPrompt } from '../git/ai'
import type { AgentSession, AiSettings, Backend, TermKind, TermTab } from '../git/backend'
import { AgentTerminal } from './Ai'
import { AgentLogo, Icon, clamp, finished, sessionMeta, stored, termTitle } from './bits'
import type { MenuState } from './Menu'
import { Splitter } from './Splitter'

const PAGE_TAG = Date.now().toString(36)

/** The agent and terminal tabs of one repository, and the panel at the bottom that shows them. */
export function useAgentPanel(p: {
  be: Backend
  active: boolean
  look: string
  /** the agents ready to use; empty when AI is off or none is installed */
  agents: { id: string; name: string }[]
  pickAgent: () => Promise<{ agent: string; settings: AiSettings } | undefined>
  openAiSettings: () => void
  say: (e: unknown) => void
  setMenu: (m: MenuState) => void
}) {
  const [terms, setTerms] = useState<TermTab[]>([])
  const [termActive, setTermActive] = useState<string>()
  const [termRunning, setTermRunning] = useState<Record<string, boolean>>({})
  const termSeq = useRef(0)
  const [shown, setShown] = useState(false)
  const [focus, setFocus] = useState(false)
  const [max, setMax] = useState(false)
  const [height, setHeight] = useState(() => Number(stored('ramulus.drawer')) || 280)
  const [paste, setPaste] = useState<{ id: number; text: string; tab: string }>()
  const [restart, setRestart] = useState({ tab: '', n: 0 })
  const [waiting, setWaiting] = useState<Set<string>>(new Set())
  /** the folder's agent conversations that no tab has open, and whether the History tab is the one showing */
  const [past, setPast] = useState<AgentSession[]>([])
  const [history, setHistory] = useState(false)
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const termsRef = useRef(terms)
  termsRef.current = terms

  const activeTerm = terms.find((t) => t.id === termActive) ?? terms[terms.length - 1]
  const looking = p.active && shown ? activeTerm?.id : undefined
  const lookingRef = useRef(looking)
  lookingRef.current = looking

  useEffect(() => {
    localStorage.setItem('ramulus.drawer', String(height))
  }, [height])

  const unwait = (ids: string[]) => setWaiting((w) => (ids.some((id) => w.has(id)) ? new Set([...w].filter((id) => !ids.includes(id))) : w))
  useEffect(() => {
    if (looking) unwait([looking])
  }, [looking, waiting])

  const label = (t: TermTab) => {
    const { label } = termTitle(t)
    if (t.title) return label
    const same = terms.filter((x) => !x.title && x.kind === t.kind && x.agent === t.agent)
    return same.length > 1 ? `${label} ${same.findIndex((x) => x.id === t.id) + 1}` : label
  }

  // Only explicit opens take the keyboard, not the remount that comes with switching repositories.
  const show = (id: string) => {
    setTermActive(id)
    setHistory(false)
    setShown(true)
    setFocus(true)
  }

  const add = (kind: TermKind, agent?: string, resume?: string) => {
    const t = { id: `${PAGE_TAG}-${++termSeq.current}`, kind, agent, resume }
    setTerms((ts) => [...ts, t])
    show(t.id)
    return t
  }

  // Looked up when the folder opens and whenever a tab opens or closes, since closing one is what makes its conversation resumable.
  const canResume = !!p.be.agentSessions && p.agents.length > 0
  const refresh = () => {
    if (!canResume) return setPast([])
    // a tab just opened to resume one may not have reached the helper yet
    p.be.agentSessions!().then((list) => setPast(list.filter((s) => !termsRef.current.some((t) => t.resume === s.id))), () => {})
  }
  useEffect(refresh, [canResume, terms.length])

  const openHistory = () => {
    setHistory(true)
    setShown(true)
    refresh()
  }

  const resume = (s: AgentSession) => {
    setPast((ps) => ps.filter((x) => x !== s))
    setQuery('')
    add('agent', s.agent, s.id)
  }
  const agentName = (id: string) => p.agents.find((a) => a.id === id)?.name ?? id
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const found = past.filter((s) => words.every((w) => `${s.title} ${agentName(s.agent)}`.toLowerCase().includes(w)))
  useEffect(() => {
    if (history && shown && p.active) search.current?.focus()
  }, [history, shown, p.active])

  const openAgent = async (conflictFile?: string) => {
    const picked = await p.pickAgent().catch((e) => void p.say(e))
    if (!picked) return
    const t = (activeTerm?.kind === 'agent' ? activeTerm : terms.findLast((x) => x.kind === 'agent')) ?? add('agent', picked.agent)
    show(t.id)
    if (conflictFile) setPaste({ id: Date.now(), tab: t.id, text: fillPrompt(picked.settings.prompts.conflict || DEFAULT_PROMPTS.conflict, conflictFile) })
  }

  const toggle = async () => {
    if (shown) return setShown(false)
    if (activeTerm) return show(activeTerm.id)
    if (past.length) return openHistory()
    if (!p.be.termStart || !p.be.ai) return p.say('Run npx ramulus in a repository to use your AI agent here')
    const info = await p.be.ai().catch(() => undefined)
    if (info && (info.settings.enabled === false || info.agents.length === 0)) return p.openAiSettings()
    openAgent()
  }

  const close = (id: string) => {
    p.be.termStop?.(id).catch(() => {})
    const rest = terms.filter((t) => t.id !== id)
    setTerms(rest)
    unwait([id])
    if (activeTerm?.id === id) setTermActive(rest[rest.length - 1]?.id)
    if (paste?.tab === id) setPaste(undefined)
    if (rest.length === 0 && !history) {
      setShown(false)
      setMax(false)
    }
  }

  const closeAll = () => {
    p.be.termStop?.().catch(() => {})
    setPaste(undefined)
    setTerms([])
    setWaiting(new Set())
    setTermActive(undefined)
    setHistory(false)
    setShown(false)
    setMax(false)
  }

  const newTermMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    p.setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        ...p.agents.map((a) => ({ label: a.name, onClick: () => void add('agent', a.id) })),
        ...(p.agents.length ? [] : [{ label: 'Set up an AI agent…', onClick: p.openAiSettings }]),
        { label: 'Terminal', onClick: () => void add('shell') },
      ],
    })
  }

  useEffect(() => {
    p.be.termList?.().then((list) => {
      if (!list.length) return
      setTerms((ts) => [...list, ...ts])
      // the tabs open when Ramulus last closed come back where they were
      setShown(true)
    }, () => {})
    return () => void p.be.termStop?.().catch(() => {})
  }, [])

  // Titles change as the programs run, such as Claude Code naming the conversation and showing it is working.
  // Agents are watched in hidden repositories too, more slowly, so the sidebar can say when one finishes.
  const watching = p.active && shown
  useEffect(() => {
    if (!p.be.termList || !terms.length || (!watching && !terms.some((t) => t.kind === 'agent'))) return
    const timer = setInterval(
      () =>
        p.be.termList!().then((list) => {
          const done = finished(termsRef.current, list).filter((id) => id !== lookingRef.current)
          if (done.length) setWaiting((w) => new Set([...w, ...done]))
          const titles = new Map(list.map((t) => [t.id, t.title]))
          const changed = (t: TermTab) => titles.has(t.id) && titles.get(t.id) !== t.title
          setTerms((ts) => (ts.some(changed) ? ts.map((t) => (changed(t) ? { ...t, title: titles.get(t.id) } : t)) : ts))
        }, () => {}),
      watching ? 1500 : 4000,
    )
    return () => clearInterval(timer)
  }, [watching, terms.length])

  const view = (history || activeTerm) && shown && p.active && (
    <div class="agent-drawer" style={max ? undefined : { height: `${height}px` }}>
      {!max && <Splitter horizontal onDrag={(dy) => setHeight((h) => clamp(h - dy, 120, innerHeight - 200))} />}
      <div class="drawer-head">
        <div class="term-tabs" role="tablist" aria-label="Agent and terminal tabs">
          {terms.map((t) => (
            <div
              key={t.id}
              role="tab"
              tabIndex={0}
              aria-selected={!history && t.id === activeTerm?.id}
              class={`term-tab ${!history && t.id === activeTerm?.id ? 'active' : ''} ${termRunning[t.id] === false ? 'stopped' : ''} ${termTitle(t).busy ? 'busy' : ''} ${waiting.has(t.id) ? 'waiting' : ''}`}
              title={termRunning[t.id] === false ? `${label(t)} (stopped)` : waiting.has(t.id) ? `${label(t)} (finished)` : label(t)}
              onClick={() => show(t.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && show(t.id)}
            >
              {t.kind === 'shell' || termTitle(t).busy ? <Icon name={t.kind === 'shell' ? 'terminal' : 'loading'} /> : <AgentLogo agent={t.agent} />}
              <span class="label">{label(t)}</span>
              <button
                class="icon"
                title="Close this tab"
                aria-label={`Close ${label(t)}`}
                onClick={(e) => {
                  e.stopPropagation()
                  close(t.id)
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          {(past.length > 0 || history) && (
            <div
              role="tab"
              tabIndex={0}
              aria-selected={history}
              class={`term-tab ${history ? 'active' : ''}`}
              title="Agent conversations in this folder that no tab has open"
              onClick={openHistory}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openHistory()}
            >
              <Icon name="history" />
              <span class="label">History</span>
            </div>
          )}
          <button class="icon" title="New agent or terminal tab" aria-label="New agent or terminal tab" onClick={newTermMenu}>
            <Icon name="add" />
          </button>
        </div>
        <span class="spacer" />
        {!history && activeTerm && (
          <button class="icon" title={`Restart this ${activeTerm.kind === 'shell' ? 'terminal' : 'agent'}`} aria-label="Restart this tab" onClick={() => setRestart((r) => ({ tab: activeTerm.id, n: r.n + 1 }))}>
            <Icon name="debug-restart" />
          </button>
        )}
        <button class="icon" title="AI agent settings" aria-label="AI agent settings" onClick={p.openAiSettings}>
          <Icon name="settings-gear" />
        </button>
        <button class="icon" title={max ? 'Restore the panel' : 'Maximize the panel'} aria-label={max ? 'Restore the panel' : 'Maximize the panel'} onClick={() => setMax((m) => !m)}>
          <Icon name={max ? 'screen-normal' : 'screen-full'} />
        </button>
        <button class="icon" title="Hide the panel (⌃`)" aria-label="Hide the panel" onClick={() => setShown(false)}>
          <Icon name="chevron-down" />
        </button>
      </div>
      {history || !activeTerm ? (
        <div class="past" role="tabpanel" aria-label="Agent conversations to resume">
          {past.length > 0 && (
            <div class="past-search">
              <input
                ref={search}
                placeholder="Search conversations"
                aria-label="Search conversations"
                value={query}
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && found[0]) resume(found[0])
                  if (e.key === 'Escape' && query) {
                    e.stopPropagation()
                    setQuery('')
                  }
                }}
              />
            </div>
          )}
          <div class="past-list">
            {found.map((s) => (
              <button key={`${s.agent} ${s.id}`} class="past-row" title={`Resume this ${agentName(s.agent)} conversation in a new tab`} onClick={() => resume(s)}>
                <AgentLogo agent={s.agent} />
                <span class="past-title">{s.title}</span>
                <span class="past-meta">{sessionMeta(s, agentName(s.agent))}</span>
              </button>
            ))}
            {!found.length && <div class="past-empty">{past.length ? 'No conversation matches that.' : 'No other agent conversations in this folder.'}</div>}
          </div>
        </div>
      ) : (
      <AgentTerminal
        key={activeTerm.id}
        be={p.be}
        id={activeTerm.id}
        kind={activeTerm.kind}
        agent={activeTerm.agent}
        resume={activeTerm.resume}
        look={p.look}
        focus={focus}
        onFocused={() => setFocus(false)}
        paste={paste?.tab === activeTerm.id ? paste : undefined}
        restart={restart.tab === activeTerm.id ? restart.n : 0}
        onState={(st) => setTermRunning((m) => ({ ...m, [activeTerm.id]: st.running }))}
        onPasted={() => setPaste(undefined)}
      />
      )}
    </div>
  )

  const open = (terms.length > 0 || history) && shown
  return {
    list: terms,
    shown,
    view,
    cls: `${open ? 'with-drawer' : ''} ${open && max ? 'drawer-max' : ''}`,
    /** what the sidebar and the Agent button say about this repository's agents */
    state: (waiting.size ? 'waiting' : terms.some((t) => termTitle(t).busy) ? 'working' : undefined) as 'waiting' | 'working' | undefined,
    show,
    add,
    openAgent,
    toggle,
    closeAll,
  }
}
