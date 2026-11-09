import { useEffect, useRef, useState } from 'preact/hooks'
import { DEFAULT_PROMPTS, fillPrompt } from '../git/ai'
import type { AgentSession, AiSettings, Backend, TermKind, TermTab } from '../git/backend'
import { AgentTerminal } from './Ai'
import { AgentLogo, Icon, finished, moved, sessionMeta, sortDrag, sortKey, termTitle } from './bits'
import type { MenuState } from './Menu'

const PAGE_TAG = Date.now().toString(36)

/**
 * The agent and terminal tabs of one repository: listed in the left panel, and in the editor's tab strip, with the one
 * in front filling the main area.
 */
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
  /** whether the left panel shows the list, which is where the conversations to resume are */
  listing: boolean
  /** asks the left panel to show the list */
  onList: () => void
}) {
  const [terms, setTerms] = useState<TermTab[]>([])
  const [termActive, setTermActive] = useState<string>()
  const [termRunning, setTermRunning] = useState<Record<string, boolean>>({})
  const termSeq = useRef(0)
  /** an agent or terminal tab, rather than the graph or a file, is what the main area shows */
  const [shown, setShown] = useState(false)
  const [focus, setFocus] = useState(false)
  const [paste, setPaste] = useState<{ id: number; text: string; tab: string }>()
  const [restart, setRestart] = useState({ tab: '', n: 0 })
  const [waiting, setWaiting] = useState<Set<string>>(new Set())
  /** the folder's agent conversations that no tab has open */
  const [past, setPast] = useState<AgentSession[]>([])
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const termsRef = useRef(terms)
  termsRef.current = terms

  const activeTerm = terms.find((t) => t.id === termActive) ?? terms[terms.length - 1]
  const looking = p.active && shown ? activeTerm?.id : undefined
  const lookingRef = useRef(looking)
  lookingRef.current = looking
  // A tab's terminal is made the first time it shows and then kept behind the others, so coming back to it, to this
  // repository or from the graph is instant.
  const made = useRef(new Set<string>())
  if (looking) made.current.add(looking)

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
    setShown(true)
    setFocus(true)
  }

  const add = (kind: TermKind, agent?: string, resume?: string) => {
    const t = { id: `${PAGE_TAG}-${++termSeq.current}`, kind, agent, resume }
    setTerms((ts) => [...ts, t])
    show(t.id)
    return t
  }

  // The helper saves the order, so the tabs come back in it.
  const reorder = (from: number, to: number) => {
    const next = moved(termsRef.current, from, to)
    setTerms(next)
    p.be.termOrder?.(next.map((t) => t.id)).catch(() => {})
  }

  // Looked up when the folder opens, when the list shows and whenever a tab opens or closes, since closing one is what
  // makes its conversation resumable.
  const canResume = !!p.be.agentSessions && p.agents.length > 0
  useEffect(() => {
    if (!canResume) return setPast([])
    // a tab just opened to resume one may not have reached the helper yet
    p.be.agentSessions!().then((list) => setPast(list.filter((s) => !termsRef.current.some((t) => t.resume === s.id))), () => {})
  }, [canResume, terms.length, p.listing])

  // only an explicit open takes the keyboard, not coming back to this repository
  const openList = () => {
    p.onList()
    requestAnimationFrame(() => search.current?.focus())
  }

  const resume = (s: AgentSession) => {
    setPast((ps) => ps.filter((x) => x !== s))
    setQuery('')
    add('agent', s.agent, s.id)
  }
  const agentName = (id: string) => p.agents.find((a) => a.id === id)?.name ?? id
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const found = past.filter((s) => words.every((w) => `${s.title} ${agentName(s.agent)}`.toLowerCase().includes(w)))

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
    if (past.length) return openList()
    if (!p.be.termStart || !p.be.ai) return p.say('Run npx ramulus in a repository to use your AI agent here')
    const info = await p.be.ai().catch(() => undefined)
    if (info && (info.settings.enabled === false || info.agents.length === 0)) return p.openAiSettings()
    openAgent()
  }

  const close = (id: string) => {
    p.be.termStop?.(id).catch(() => {})
    made.current.delete(id)
    const i = terms.findIndex((t) => t.id === id)
    const rest = terms.filter((t) => t.id !== id)
    setTerms(rest)
    unwait([id])
    // like an editor tab, the one beside it comes to the front
    if (activeTerm?.id === id) setTermActive(rest[Math.min(i, rest.length - 1)]?.id)
    if (paste?.tab === id) setPaste(undefined)
    if (rest.length === 0) setShown(false)
  }

  const closeAll = () => {
    p.be.termStop?.().catch(() => {})
    made.current.clear()
    setPaste(undefined)
    setTerms([])
    setWaiting(new Set())
    setTermActive(undefined)
    setShown(false)
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

  // The tabs open when Ramulus last closed come back in the order they had, the last one in front, which starts it
  // again so its title stops saying it was working when Ramulus closed.
  useEffect(() => {
    p.be.termList?.().then((list) => {
      if (!list.length) return
      setTerms((ts) => [...list, ...ts])
      setShown(true)
    }, () => {})
    return () => void p.be.termStop?.().catch(() => {})
  }, [])

  // Titles change as the programs run, such as Claude Code naming the conversation and showing it is working.
  // Agents are watched in hidden repositories too, more slowly, so the sidebar can say when one finishes.
  const watching = p.active && shown
  useEffect(() => {
    if (!p.be.termList || !terms.length || (!p.active && !terms.some((t) => t.kind === 'agent'))) return
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
  }, [watching, p.active, terms.length])

  const front = (t: TermTab) => shown && t.id === activeTerm?.id
  const marks = (t: TermTab) => `${front(t) ? 'active' : ''} ${termRunning[t.id] === false ? 'stopped' : ''} ${termTitle(t).busy ? 'busy' : ''} ${waiting.has(t.id) ? 'waiting' : ''}`
  const tip = (t: TermTab) => (termRunning[t.id] === false ? `${label(t)} (stopped)` : waiting.has(t.id) ? `${label(t)} (finished)` : label(t))
  const mark = (t: TermTab) => (t.kind === 'shell' || termTitle(t).busy ? <Icon name={t.kind === 'shell' ? 'terminal' : 'loading'} /> : <AgentLogo agent={t.agent} />)
  // the same tab, as a row of the list or a tab of the strip; dragging either one reorders both
  const tab = (t: TermTab, i: number, axis: 'x' | 'y') => (
    <div
      key={t.id}
      data-sort="term"
      role="tab"
      tabIndex={0}
      aria-selected={front(t)}
      class={`${axis === 'x' ? 'tab' : 'term-row'} term ${marks(t)}`}
      title={tip(t)}
      onClick={() => show(t.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          show(t.id)
        } else sortKey(e, axis, i, terms.length, reorder)
      }}
      onMouseDown={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        close(t.id)
      }}
      onPointerDown={(e) => sortDrag(e, axis, reorder)}
    >
      {mark(t)}
      <span class="name">{label(t)}</span>
      <button
        class="icon close"
        title="Close this tab"
        aria-label={`Close ${label(t)}`}
        onClick={(e) => {
          e.stopPropagation()
          close(t.id)
        }}
      >
        <span class="dot">
          <Icon name="circle-filled" />
        </span>
        <span class="x">
          <Icon name="close" />
        </span>
      </button>
    </div>
  )

  const side = (
    <div class="agents">
      <div class="agents-head">
        <span class="title">Tabs</span>
        <button class="icon" title="New agent or terminal tab" aria-label="New agent or terminal tab" onClick={newTermMenu}>
          <Icon name="add" />
        </button>
        <button class="icon" title="AI agent settings" aria-label="AI agent settings" onClick={p.openAiSettings}>
          <Icon name="settings-gear" />
        </button>
      </div>
      <div class="term-list" role="tablist" aria-orientation="vertical" aria-label="Agent and terminal tabs">
        {terms.map((t, i) => tab(t, i, 'y'))}
        {!terms.length && <div class="past-empty">No agent or terminal tabs. Start one with +.</div>}
      </div>
      {past.length > 0 && (
        <>
          <div class="agents-head">
            <span class="title">History</span>
            <span class="count" title="Agent conversations in this folder that no tab has open">
              {past.length}
            </span>
          </div>
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
          <div class="past-list" aria-label="Agent conversations to resume">
            {found.map((s) => (
              <button key={`${s.agent} ${s.id}`} class="past-row" title={`Resume this ${agentName(s.agent)} conversation in a new tab`} onClick={() => resume(s)}>
                <AgentLogo agent={s.agent} />
                <span class="past-title">{s.title}</span>
                <span class="past-meta">{sessionMeta(s, agentName(s.agent))}</span>
              </button>
            ))}
            {!found.length && <div class="past-empty">No conversation matches that.</div>}
          </div>
        </>
      )}
    </div>
  )

  const panes = (
    <div key="terms" class="diff-pane term-panes" hidden={!shown}>
      {terms
        .filter((t) => made.current.has(t.id))
        .map((t) => (
          <AgentTerminal
            key={t.id}
            be={p.be}
            id={t.id}
            kind={t.kind}
            agent={t.agent}
            resume={t.resume}
            look={p.look}
            shown={t.id === activeTerm?.id}
            focus={focus && t.id === activeTerm?.id}
            onFocused={() => setFocus(false)}
            paste={paste?.tab === t.id ? paste : undefined}
            restart={restart.tab === t.id ? restart.n : 0}
            onState={(st) => setTermRunning((m) => ({ ...m, [t.id]: st.running }))}
            onPasted={() => setPaste(undefined)}
          />
        ))}
    </div>
  )

  const actions = activeTerm && (
    <button class="icon" title={`Restart this ${activeTerm.kind === 'shell' ? 'terminal' : 'agent'}`} aria-label="Restart this tab" onClick={() => setRestart((r) => ({ tab: activeTerm.id, n: r.n + 1 }))}>
      <Icon name="debug-restart" />
    </button>
  )

  return {
    list: terms,
    shown,
    /** the list, for the left panel */
    side,
    /** the tabs, for the editor's tab strip */
    tabs: terms.map((t, i) => tab(t, i, 'x')),
    /** the terminals, for the main area */
    panes,
    /** the buttons for the tab in front, for the tab strip */
    actions,
    /** what the sidebar and the Agent button say about this repository's agents */
    state: (waiting.size ? 'waiting' : terms.some((t) => termTitle(t).busy) ? 'working' : undefined) as 'waiting' | 'working' | undefined,
    show,
    hide: () => setShown(false),
    add,
    openAgent,
    toggle,
    closeAll,
  }
}
