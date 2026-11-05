import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { DEFAULT_PROMPTS, branchName, fillPrompt, splitMessage } from '../git/ai'
import type { AiInfo, AiSettings, Backend, MergeMethod, PrChange, PullMode, PullRequest, PushResult, RebaseResult, RemoteSwitch, TermKind, TermTab } from '../git/backend'
import { layout, type RowLayout } from '../git/graph'
import { PAGE, type Commit, type DiffArea, type FileChange, type NetSettings, type RepoData } from '../git/repo'
import type { Scheme } from '../git/scheme'
import { AgentTerminal, AiConsent, AiSettingsDialog } from './Ai'
import { BrandLinks, BrandMark, Icon, SidebarToggle, laneColor, prsByBranch, short, termTitle } from './bits'
import { DetailPanel, type FileSel } from './DetailPanel'
import { PrCard } from './PrView'
import { DiffWindow, tabKey, type DiffOptions, type DiffTab } from './DiffWindow'
import type { ChunkAction } from './DiffEditor'
import { Dialogs, type Dialog } from './Dialogs'
import { GraphView, type DropInfo, type PillData } from './GraphView'
import { LeftPanel, type LeftMode } from './LeftPanel'
import { Menu, type MenuItem, type MenuState } from './Menu'
import { Palette, type Command } from './Palette'
import type { RepoSummary } from './Sidebar'
import { Shortcuts } from './Shortcuts'
import { Splitter } from './Splitter'

interface View {
  be: Backend
  data: RepoData
  rows: Commit[]
  layout: RowLayout[]
  maxCol: number
  indexOf: Map<string, number>
  limit: number
}

type Sel = { kind: 'wip' } | { kind: 'commit'; oid: string }

const WIP = '0000000000000000000000000000000000000000'
const SETTINGS_KEY = 'ramulus.net'
const PAGE_TAG = Date.now().toString(36)
const CHANGE_LABEL: Record<PrChange, [string, string]> = { draft: ['Marking as draft', 'is a draft now'], ready: ['Marking ready for review', 'is ready for review'], close: ['Closing', 'is closed'], reopen: ['Reopening', 'is open again'] }
const stored = (key: string) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(key))

function buildView(be: Backend, data: RepoData, limit: number): View {
  const rows: Commit[] = [...data.commits]
  if (data.status.staged.length + data.status.unstaged.length > 0) {
    rows.unshift({
      id: WIP,
      parents: data.headOid ? [data.headOid] : [],
      author: '',
      email: '',
      time: Math.floor(Date.now() / 1000),
      summary: '',
      body: '',
      kind: 'wip',
    })
  }
  const l = layout(rows)
  const indexOf = new Map(rows.map((c, i) => [c.id, i]))
  return { be, data, rows, layout: l.rows, maxCol: l.maxCol, indexOf, limit }
}

export type Theme = 'dark' | 'light'

export function loadSettings(): NetSettings {
  const base: NetSettings = { corsProxy: '', username: '', token: '', authorName: '', authorEmail: '' }
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    return { ...base, ...saved, token: sessionStorage.getItem(SETTINGS_KEY + '.token') ?? '' }
  } catch {
    return base
  }
}

function saveSettings(s: NetSettings) {
  const { token, ...rest } = s
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest))
  sessionStorage.setItem(SETTINGS_KEY + '.token', token)
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

const PULL_MODES: Record<PullMode, string> = { merge: 'Merge', 'ff-only': 'Fast-forward only', rebase: 'Rebase' }

export interface TabApi {
  pull: () => Promise<void>
  fetch: () => Promise<void>
  showTerm: (id: string) => void
}

const notGit = (e: unknown) => /not a git repository/i.test(e instanceof Error ? e.message : String(e))

export function App(p: { be: Backend; name: string; active: boolean; theme: Theme; onTheme: (t: Theme) => void; scheme?: Scheme; onScheme: (s?: Scheme) => void; onOpenRepo: () => void; onDirty: (dirty: boolean) => void; onApi: (api: TabApi) => void; onSearchRepos: () => void; onAll: (kind: 'pull' | 'fetch') => void; mergeMethod: MergeMethod; onMergeMethod: (m: MergeMethod) => void; onSummary: (s: RepoSummary) => void; sidebar: boolean; onToggleSidebar: () => void }) {
  const theme = p.theme
  const look = p.scheme ? `scheme:${p.scheme.id}` : theme
  const setTheme = (t: Theme) => {
    p.onScheme(undefined)
    p.onTheme(t)
  }
  const themeMenu = (e: MouseEvent) =>
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Dark', checked: !p.scheme && theme === 'dark', onClick: () => setTheme('dark') },
        { label: 'Light', checked: !p.scheme && theme === 'light', onClick: () => setTheme('light') },
        ...(p.scheme ? [{ label: p.scheme.name, checked: true }] : []),
        { sep: true },
        { label: 'Color scheme from a link…', onClick: () => setDialog({ kind: 'scheme' }) },
      ],
    })
  const [view, setView] = useState<View>()
  const [sel, setSel] = useState<Sel>()
  const [diffTabs, setDiffTabs] = useState<DiffTab[]>([])
  const [activeDiff, setActiveDiff] = useState<string>()
  const [onGraph, setOnGraph] = useState(false)
  const [commitFiles, setCommitFiles] = useState<FileChange[]>([])
  const [diffOptions, setDiffOptionsState] = useState<DiffOptions>(() => ({ wrap: stored('ramulus.wrap') === '1', mode: stored('ramulus.diff') === 'inline' ? 'inline' : 'split', collapse: stored('ramulus.collapse') !== '0' }))
  const setDiffOptions = (o: DiffOptions) => {
    setDiffOptionsState(o)
    localStorage.setItem('ramulus.wrap', o.wrap ? '1' : '0')
    localStorage.setItem('ramulus.diff', o.mode)
    localStorage.setItem('ramulus.collapse', o.collapse ? '1' : '0')
  }
  const [tree, setTreeState] = useState(() => stored('ramulus.tree') === '1')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [amend, setAmend] = useState(false)
  const [filter, setFilter] = useState('')
  const [solo, setSolo] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog>()
  const [menu, setMenu] = useState<MenuState>()
  const [palette, setPalette] = useState<false | 'all' | 'branches'>(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [toast, setToast] = useState<string>()
  const [undo, setUndo] = useState<{ before: string; onto: string }>()
  const [showLeft, setShowLeft] = useState(true)
  const [leftMode, setLeftMode] = useState<LeftMode>('branches')
  const [prs, setPrs] = useState<Map<string, PullRequest>>(new Map())
  const [leftW, setLeftW] = useState(() => Number(stored('ramulus.leftw')) || 380)
  const [scrollTo, setScrollTo] = useState<number>()
  const [updatedAt, setUpdatedAt] = useState<Date>()
  const [settings, setSettings] = useState<NetSettings>(loadSettings)
  const [pullMode, setPullMode] = useState<PullMode>('merge')
  const [aiInfo, setAiInfo] = useState<AiInfo>()
  const [aiDialog, setAiDialog] = useState<'consent' | 'settings'>()
  const [drafting, setDrafting] = useState<'commit' | 'branch'>()
  const draftStop = useRef<AbortController | undefined>(undefined)
  const [terms, setTerms] = useState<TermTab[]>([])
  const [noGit, setNoGit] = useState(false)
  const [termActive, setTermActive] = useState<string>()
  const [termRunning, setTermRunning] = useState<Record<string, boolean>>({})
  const termSeq = useRef(0)
  const [drawerShown, setDrawerShown] = useState(false)
  const [termFocus, setTermFocus] = useState(false)
  const [drawerMax, setDrawerMax] = useState(false)
  const [drawerH, setDrawerH] = useState(() => Number(stored('ramulus.drawer')) || 280)
  const [paste, setPaste] = useState<{ id: number; text: string; tab: string }>()
  const [restart, setRestart] = useState({ tab: '', n: 0 })
  const consent = useRef<((agent?: string) => void) | undefined>(undefined)
  const overlayRef = useRef(false)
  const filterRef = useRef<HTMLInputElement>(null)
  const openPalette = (on: boolean | 'branches') => {
    overlayRef.current = !!on
    setPalette(on === true ? 'all' : on)
  }
  const viewRef = useRef(view)
  viewRef.current = view
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    localStorage.setItem('ramulus.drawer', String(drawerH))
  }, [drawerH])
  useEffect(() => {
    localStorage.setItem('ramulus.leftw', String(leftW))
  }, [leftW])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(undefined), 4000)
    return () => clearTimeout(t)
  }, [toast])
  const setTree = (t: boolean) => {
    setTreeState(t)
    localStorage.setItem('ramulus.tree', t ? '1' : '0')
  }

  const fail = (title: string, e: unknown) => setDialog({ kind: 'error', title, message: e instanceof Error ? e.message : String(e) })
  useEffect(() => {
    p.be.ai?.().then(setAiInfo, () => {})
  }, [p.be])

  const applyData = useCallback((be: Backend, data: RepoData, limit: number, fresh: boolean) => {
    const v = buildView(be, data, limit)
    setView(v)
    setUpdatedAt(new Date())
    setSel((cur) => {
      const hasWip = v.rows[0]?.kind === 'wip'
      const keep = !fresh && cur && (cur.kind === 'wip' ? hasWip : v.indexOf.has(cur.oid))
      if (keep) return cur
      return hasWip ? { kind: 'wip' } : data.headOid ? { kind: 'commit', oid: data.headOid } : undefined
    })
    if (fresh) {
      setDiffTabs([])
      setFilter('')
      setSolo(new Set())
      setSummary('')
      setDescription('')
      setAmend(false)
    }
  }, [])

  const openBackend = async (be: Backend) => {
    setBusy('Reading repository')
    try {
      applyData(be, await be.load(PAGE), PAGE, true)
      setNoGit(false)
    } catch (e) {
      if (notGit(e)) setNoGit(true)
      else fail('Could not read the repository', e)
    } finally {
      setBusy(undefined)
    }
  }

  useEffect(() => {
    openBackend(p.be)
  }, [])

  const reload = useCallback(async () => {
    const v = viewRef.current
    if (!v) return
    try {
      applyData(v.be, await v.be.load(v.limit), v.limit, false)
    } catch (e) {
      fail('Could not read the repository', e)
    }
  }, [applyData])

  useEffect(() => {
    const remote = async (label: string, fn: (v: View) => Promise<unknown>) => {
      const v = viewRef.current
      if (!v) throw new Error('still loading')
      if (busyRef.current) throw new Error(`busy: ${busyRef.current.toLowerCase()}`)
      busyRef.current = label
      setBusy(label)
      try {
        await fn(v)
      } finally {
        busyRef.current = undefined
        setBusy(undefined)
      }
      await reload()
    }
    p.onApi({
      pull: () =>
        remote('Pulling', (v) => {
          if (!v.data.headBranch) throw new Error('no branch is checked out')
          return v.be.pull('ff-only', v.data.headBranch)
        }),
      fetch: () => remote('Fetching', (v) => v.be.fetchAll()),
      showTerm: (id) => showTerm(id),
    })
  }, [])

  useEffect(() => {
    if (noGit) p.onSummary({ branch: '', changes: 0, ahead: 0, behind: 0, busy: false, noGit })
  }, [noGit])

  // a folder without git becomes a repository once git init runs in it, here or anywhere;
  // checking now and then, because watching a big plain folder such as ~ costs far more
  useEffect(() => {
    if (!noGit || !p.active) return
    const timer = setInterval(() => p.be.load(PAGE).then((d) => (setNoGit(false), applyData(p.be, d, PAGE, true)), () => {}), 3000)
    return () => clearInterval(timer)
  }, [noGit, p.active])

  useEffect(() => {
    if (!view?.be.subscribe || !p.active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    return view.be.subscribe(() => {
      clearTimeout(timer)
      timer = setTimeout(reload, 150)
    })
  }, [view?.be, reload, p.active])

  useEffect(() => {
    if (p.active) reload()
  }, [p.active])

  useEffect(() => {
    if (!view) return
    const cur = view.data.local.find((b) => b.isHead)
    const s = view.data.status
    p.onSummary({
      branch: view.data.headBranch ?? (view.data.headOid ? 'detached' : ''),
      changes: new Set([...s.staged, ...s.unstaged].map((f) => f.path)).size,
      ahead: cur?.ahead ?? 0,
      behind: cur?.behind ?? 0,
      busy: !!busy,
    })
  }, [view, busy])

  useEffect(() => {
    const fresh = (t: DiffTab) => {
      const now = t.pr && prs.get(t.pr.branch)
      return now && now.number === t.pr!.number && now.state !== t.pr!.state ? now : undefined
    }
    setDiffTabs((ts) => (ts.some(fresh) ? ts.map((t) => ({ ...t, pr: fresh(t) ?? t.pr })) : ts))
  }, [prs])

  useEffect(() => {
    if (!view || !p.be.prs) return
    let live = true
    p.be.prs().then((list) => live && setPrs(prsByBranch(list)), () => {})
    return () => {
      live = false
    }
  }, [view])

  const run = async (label: string, fn: () => Promise<unknown>, opts: { after?: (r: unknown) => void; statusOnly?: boolean } = {}) => {
    if (!view || busy) return
    setBusy(label)
    try {
      const r = await fn()
      opts.after?.(r)
    } catch (e) {
      fail('Git could not do that', e)
    } finally {
      setBusy(undefined)
    }
    if (opts.statusOnly) {
      try {
        applyData(view.be, { ...view.data, status: await view.be.status() }, view.limit, false)
      } catch (e) {
        fail('Could not read the repository', e)
      }
    } else {
      await reload()
    }
  }

  useEffect(() => {
    if (!view) return
    if (sel?.kind === 'commit') {
      view.be.commitFiles(sel.oid).then(setCommitFiles).catch(() => setCommitFiles([]))
    } else {
      setCommitFiles([])
    }
  }, [view, sel])

  useEffect(() => {
    if (!view) return
    const gone = (t: DiffTab) => {
      if (t.dirty || t.file || t.pr || t.sel.area.kind === 'commit') return false
      const list = t.sel.area.kind === 'staged' ? view.data.status.staged : view.data.status.unstaged
      return !list.some((f) => f.path === t.sel.path)
    }
    setDiffTabs((ts) => (ts.some(gone) ? ts.filter((t) => !gone(t)) : ts))
  }, [view])

  const soloInfo = useMemo(() => {
    if (!view || solo.size === 0) return undefined
    const tips = new Set<string>()
    for (const b of [...view.data.local, ...view.data.remote]) if (solo.has(b.name)) tips.add(b.oid)
    const parents = new Map(view.rows.map((r) => [r.id, r.parents]))
    const keep = new Set<string>()
    const stack = [...tips]
    while (stack.length) {
      const id = stack.pop()!
      if (keep.has(id) || !parents.has(id)) continue
      keep.add(id)
      for (const p of parents.get(id) ?? []) stack.push(p)
    }
    if (view.data.headOid && keep.has(view.data.headOid)) keep.add(WIP)
    const indices = view.rows.map((_, i) => i).filter((i) => keep.has(view.rows[i].id))
    const l = layout(indices.map((i) => view.rows[i]))
    return { indices, layoutByIndex: new Map(indices.map((i, k) => [i, l.rows[k]])), maxCol: l.maxCol }
  }, [view, solo])

  const order = useMemo(() => {
    if (!view) return []
    const base = soloInfo?.indices ?? view.rows.map((_, i) => i)
    const q = filter.trim().toLowerCase()
    if (!q) return base
    return base.filter((i) => {
      const c = view.rows[i]
      return (
        c.summary.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.id.startsWith(q) ||
        (view.data.refsByOid.get(c.id) ?? []).some((l) => l.name.toLowerCase().includes(q))
      )
    })
  }, [view, filter, soloInfo])

  const selectedIndex = !view || !sel ? -1 : sel.kind === 'wip' ? (view.rows[0]?.kind === 'wip' ? 0 : -1) : (view.indexOf.get(sel.oid) ?? -1)

  const select = (index: number) => {
    if (!view) return
    const c = view.rows[index]
    if (!c) return
    const next: Sel = c.kind === 'wip' ? { kind: 'wip' } : { kind: 'commit', oid: c.id }
    if (JSON.stringify(next) !== JSON.stringify(sel)) setSel(next)
  }

  const jump = (oid: string) => {
    if (!view) return
    const i = view.indexOf.get(oid)
    if (i === undefined) {
      setToast('That commit is not loaded yet')
      return
    }
    if (soloInfo && !soloInfo.indices.includes(i)) setSolo(new Set())
    select(i)
    setScrollTo(i)
    setOnGraph(true)
  }

  const copy = (s: string) => {
    navigator.clipboard.writeText(s).then(() => setToast('Copied!'))
  }

  const toggleSolo = (name: string) =>
    setSolo((s) => {
      const next = new Set(s)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const head = view?.data.headBranch
  const confirm = (message: string, action: () => void) => setDialog({ kind: 'confirm', message, action })

  const aiReady = !!p.be.aiAsk && !!aiInfo?.agents.length && aiInfo.settings.enabled !== false

  const pickAgent = async (): Promise<{ agent: string; settings: AiSettings } | undefined> => {
    const info = await p.be.ai!()
    setAiInfo(info)
    const s = info.settings
    if (s.enabled && s.agent && info.agents.some((a) => a.id === s.agent)) return { agent: s.agent, settings: s }
    if (s.enabled === false || info.agents.length === 0) return undefined
    const agent = await new Promise<string | undefined>((resolve) => {
      consent.current = resolve
      setAiDialog('consent')
    })
    return agent ? { agent, settings: { ...s, enabled: true, agent } } : undefined
  }

  const answerConsent = async (choice?: string | false) => {
    setAiDialog(undefined)
    const done = consent.current
    consent.current = undefined
    if (choice !== undefined && aiInfo) {
      const settings: AiSettings = { ...aiInfo.settings, enabled: choice !== false, ...(choice ? { agent: choice } : {}) }
      try {
        await p.be.setAi!(settings)
        setAiInfo({ ...aiInfo, settings })
      } catch (e) {
        setToast(`Could not save the AI setting: ${e instanceof Error ? e.message : String(e)}`)
        return done?.(undefined)
      }
    }
    done?.(choice || undefined)
  }

  const agentName = (id?: string) => aiInfo?.agents.find((a) => a.id === id)?.name ?? id ?? ''
  const say = (e: unknown) => setToast(e instanceof Error ? e.message : String(e))

  const aiDraft = async (task: 'commit' | 'branch', at?: string) => {
    if (draftStop.current) return draftStop.current.abort()
    const picked = await pickAgent().catch((e) => void say(e))
    if (!picked) return
    const stop = new AbortController()
    draftStop.current = stop
    setDrafting(task)
    try {
      const context = await p.be.aiContext!(task, at)
      const reply = await p.be.aiAsk!(picked.agent, `${picked.settings.prompts[task] || DEFAULT_PROMPTS[task]}\n\n${context}`, stop.signal)
      if (task === 'commit') {
        const m = splitMessage(reply)
        setSummary(m.summary)
        setDescription(m.description)
        setToast(`${agentName(picked.agent)} drafted it. Review, then commit.`)
      } else setDialog((d) => (d?.kind === 'branch' ? { ...d, name: branchName(reply) } : d))
    } catch (e) {
      if (!stop.signal.aborted) say(e)
    } finally {
      draftStop.current = undefined
      setDrafting(undefined)
    }
  }

  const activeTerm = terms.find((t) => t.id === termActive) ?? terms[terms.length - 1]
  const termLabel = (t: TermTab) => {
    const { label } = termTitle(t)
    if (t.title) return label
    const same = terms.filter((x) => !x.title && x.kind === t.kind && x.agent === t.agent)
    return same.length > 1 ? `${label} ${same.findIndex((x) => x.id === t.id) + 1}` : label
  }

  // Only explicit opens take the keyboard, not the remount that comes with switching repositories.
  const showTerm = (id: string) => {
    setTermActive(id)
    setDrawerShown(true)
    setTermFocus(true)
  }

  const addTerm = (kind: TermKind, agent?: string) => {
    const t = { id: `${PAGE_TAG}-${++termSeq.current}`, kind, agent }
    setTerms((ts) => [...ts, t])
    showTerm(t.id)
    return t
  }

  const openAgent = async (conflictFile?: string) => {
    const picked = await pickAgent().catch((e) => void say(e))
    if (!picked) return
    const t = (activeTerm?.kind === 'agent' ? activeTerm : terms.findLast((x) => x.kind === 'agent')) ?? addTerm('agent', picked.agent)
    showTerm(t.id)
    if (conflictFile) setPaste({ id: Date.now(), tab: t.id, text: fillPrompt(picked.settings.prompts.conflict || DEFAULT_PROMPTS.conflict, conflictFile) })
  }

  const toggleAgent = async () => {
    if (drawerShown) return setDrawerShown(false)
    if (activeTerm) return showTerm(activeTerm.id)
    if (!p.be.termStart || !p.be.ai) return setToast('Run npx ramulus in a repository to use your AI agent here')
    const info = await p.be.ai().catch(() => undefined)
    if (info && (info.settings.enabled === false || info.agents.length === 0)) return openAiSettings()
    openAgent()
  }

  const closeTerm = (id: string) => {
    p.be.termStop?.(id).catch(() => {})
    const rest = terms.filter((t) => t.id !== id)
    setTerms(rest)
    if (activeTerm?.id === id) setTermActive(rest[rest.length - 1]?.id)
    if (paste?.tab === id) setPaste(undefined)
    if (rest.length === 0) {
      setDrawerShown(false)
      setDrawerMax(false)
    }
  }

  const closeAllTerms = () => {
    p.be.termStop?.().catch(() => {})
    setPaste(undefined)
    setTerms([])
    setTermActive(undefined)
    setDrawerShown(false)
    setDrawerMax(false)
  }

  const newTermMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const agents = aiReady ? (aiInfo?.agents ?? []) : []
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        ...agents.map((a) => ({ label: a.name, onClick: () => void addTerm('agent', a.id) })),
        ...(agents.length ? [] : [{ label: 'Set up an AI agent…', onClick: openAiSettings }]),
        { label: 'Terminal', onClick: () => void addTerm('shell') },
      ],
    })
  }
  useEffect(() => {
    p.be.termList?.().then((list) => {
      if (!list.length) return
      setTerms((ts) => [...list, ...ts])
      // the tabs open when Ramulus last closed come back where they were
      setDrawerShown(true)
    }, () => {})
    return () => void p.be.termStop?.().catch(() => {})
  }, [])

  // titles change as the programs run, such as Claude Code naming the conversation and showing it is working
  useEffect(() => {
    if (!drawerShown || !p.active || !terms.length || !p.be.termList) return
    const timer = setInterval(
      () =>
        p.be.termList!().then((list) => {
          const titles = new Map(list.map((t) => [t.id, t.title]))
          const changed = (t: TermTab) => titles.has(t.id) && titles.get(t.id) !== t.title
          setTerms((ts) => (ts.some(changed) ? ts.map((t) => (changed(t) ? { ...t, title: titles.get(t.id) } : t)) : ts))
        }, () => {}),
      1500,
    )
    return () => clearInterval(timer)
  }, [drawerShown, p.active, terms.length])

  const closeDialog = () => {
    if (drafting === 'branch') draftStop.current?.abort()
    setDialog(undefined)
  }

  const openAiSettings = () =>
    p.be.ai!().then(
      (i) => (setAiInfo(i), setAiDialog('settings')),
      (e) => fail('Could not read the AI settings', e),
    )

  const aiCommands = (): Command[] => {
    if (!p.be.ai) return []
    const list: Command[] = [{ id: 'ai-settings', group: 'AI', label: 'AI agent settings', run: openAiSettings }]
    if (!p.be.termStart) return list
    list.push({ id: 'ai-term', group: 'AI', label: drawerShown ? 'Hide the agent panel' : 'Show the agent panel', hint: '⌃`', run: toggleAgent })
    list.push({ id: 'term-new', group: 'AI', label: 'New terminal tab', run: () => void addTerm('shell') })
    if (terms.length) list.push({ id: 'ai-stop', group: 'AI', label: 'Close every agent and terminal tab', run: closeAllTerms })
    if (!aiReady) return list
    if (view?.data.status.staged.length) list.push({ id: 'ai-commit', group: 'AI', label: 'Draft a commit message with your AI agent', run: () => aiDraft('commit') })
    for (const f of view?.data.status.unstaged.filter((x) => x.conflict) ?? []) list.push({ id: `ai-fix:${f.path}`, group: 'AI', label: `Fix the conflict in ${f.path} with your AI agent`, run: () => openAgent(f.path) })
    return list
  }

  const conflictToast = (r: unknown) => r === 'conflicts' && setToast('There are conflicts to resolve')

  const doCommit = () => {
    if (!view || !summary.trim()) return
    const msg = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim()
    run('Committing', () => view.be.commit(msg, amend), {
      after: () => {
        setSummary('')
        setDescription('')
        setAmend(false)
      },
    })
  }

  const mergeInto = (name: string) => {
    const v = view!
    return run('Merging', () => v.be.merge(name, head!), {
      after: (r) => {
        if (r === 'up-to-date') setToast(`Already up to date with ${name}`)
        conflictToast(r)
      },
    })
  }

  const rebaseOnto = (target: string) => {
    const v = view!
    const label = /^[0-9a-f]{40}$/.test(target) ? (v.data.refsByOid.get(target)?.find((r) => r.kind !== 'tag')?.name ?? short(target)) : target
    return run('Rebasing', () => v.be.rebase!(target), {
      after: (r) => {
        const res = r as RebaseResult
        setUndo({ before: res.before, onto: label })
        if (res.result === 'conflicts') setToast('Rebase stopped on conflicts')
        else if (res.result === 'stash-conflicts') setToast('Rebased. Your changes conflicted when put back.')
      },
    })
  }

  const pushHead = (lease?: string) => {
    const v = view
    if (!v || !head) return
    return run(lease ? 'Force pushing' : 'Pushing', () => v.be.push(head, lease), { after: (r) => afterPush(r as PushResult | void, lease) })
  }

  const afterPush = (r: PushResult | void, lease?: string) => {
    if (!r || r.result === 'pushed') return setToast(lease ? 'Force push done' : 'Push done')
    const v = view!
    const integrate = (how: PullMode) => () =>
      run(how === 'rebase' ? 'Rebasing onto the remote' : 'Merging the remote', async () => {
        try {
          await v.be.pull(how, head!)
        } catch (e) {
          if ((await v.be.status()).state) return 'conflicts'
          throw e
        }
        return v.be.push(head!)
      }, {
        after: (x) => (x === 'conflicts' ? setToast('Resolve, Continue, then push again') : afterPush(x as PushResult | void)),
      })
    const n = (k: number) => `${k} commit${k === 1 ? '' : 's'}`
    const force = () => confirm(`Force pushing replaces ${head} on the remote and drops ${n(r.behind)} that only the remote has. Continue?`, () => pushHead(r.theirs))
    setDialog({ kind: 'push-rejected', branch: head!, ahead: r.ahead, behind: r.behind, rebase: integrate('rebase'), merge: integrate('merge'), force })
  }

  const undoRebase = () => {
    const v = view
    const u = undo
    if (!v || !u || !v.be.undoRebase) return
    confirm(`Put ${head ?? 'the branch'} back where it was before the rebase onto ${u.onto}? Your uncommitted changes are kept.`, () =>
      run('Undoing rebase', () => v.be.undoRebase!(u.before), {
        after: (r) => {
          setUndo(undefined)
          setToast(r === 'stash-conflicts' ? 'Rebase undone. Your uncommitted changes conflicted when they were put back.' : 'Rebase undone')
        },
      }),
    )
  }

  const branchItems = (name: string, oid: string, isHead: boolean): MenuItem[] => {
    const v = view!
    const items: MenuItem[] = []
    if (!isHead) {
      items.push({ label: `Switch to ${name}`, onClick: () => run('Switching branch', () => v.be.checkoutBranch(name)) })
      if (head) items.push({ label: `Merge ${name} into ${head}`, onClick: () => mergeInto(name) })
      if (head && v.be.rebase) items.push({ label: `Rebase ${head} onto ${name}`, onClick: () => rebaseOnto(name) })
    }
    items.push({ label: solo.has(name) ? `Stop soloing ${name}` : `Solo ${name}`, onClick: () => toggleSolo(name) })
    items.push({ label: `Rename ${name}`, onClick: () => setDialog({ kind: 'rename', old: name }) })
    items.push({ label: 'New branch from here', onClick: () => setDialog({ kind: 'branch', at: oid }) })
    items.push({ label: 'Copy name', onClick: () => copy(name) })
    if (!isHead) {
      items.push({ sep: true })
      items.push({ label: `Delete ${name}`, danger: true, onClick: () => confirm(`Delete "${name}"? This cannot be undone.`, () => run('Deleting branch', () => v.be.deleteBranch(name))) })
    }
    return items
  }

  const remoteItems = (name: string): MenuItem[] => {
    const v = view!
    return [
      { label: `Switch to ${name}`, onClick: () => switchRemote(name) },
      ...(head ? [{ label: `Merge ${name} into ${head}`, onClick: () => mergeInto(name) }] : []),
      ...(head && v.be.rebase ? [{ label: `Rebase ${head} onto ${name}`, onClick: () => rebaseOnto(name) }] : []),
      { label: solo.has(name) ? `Stop soloing ${name}` : `Solo ${name}`, onClick: () => toggleSolo(name) },
      { label: 'Copy name', onClick: () => copy(name) },
    ]
  }

  const tagItems = (name: string, oid: string): MenuItem[] => {
    const v = view!
    return [
      { label: `Check out ${name} (no branch)`, onClick: () => run('Checking out', () => v.be.checkoutCommit(oid)) },
      { label: 'Copy name', onClick: () => copy(name) },
      { sep: true },
      { label: `Delete tag ${name}`, danger: true, onClick: () => confirm(`Delete "${name}"? This cannot be undone.`, () => run('Deleting tag', () => v.be.deleteTag(name))) },
    ]
  }

  const stashItems = (index: number, message: string): MenuItem[] => {
    const v = view!
    return [
      { label: 'Apply (keep stash)', onClick: () => run('Applying stash', () => v.be.stashApply(index, false)) },
      { label: 'Apply and drop', onClick: () => run('Applying stash', () => v.be.stashApply(index, true)) },
      { sep: true },
      { label: 'Drop stash', danger: true, onClick: () => confirm(`Drop the stash "${message}"? This cannot be undone.`, () => run('Dropping stash', () => v.be.stashDrop(index))) },
    ]
  }

  const rowMenu = (e: MouseEvent, index: number) => {
    if (!view) return
    const c = view.rows[index]
    select(index)
    const v = view
    let items: MenuItem[] = []
    if (c.kind === 'wip') {
      items = [
        { label: 'Stash everything', onClick: () => setDialog({ kind: 'stash' }) },
        { label: 'Stage everything', onClick: () => run('Staging', () => v.be.stage(v.data.status.unstaged), { statusOnly: true }) },
        { sep: true },
        {
          label: 'Throw away all changes',
          danger: true,
          onClick: () =>
            confirm('Every staged, unstaged and untracked change in the working tree will be lost. Continue?', () =>
              run(
                'Discarding',
                async () => {
                  if (v.data.status.staged.length) await v.be.unstage(v.data.status.staged.map((f) => f.path))
                  const st = await v.be.status()
                  if (st.unstaged.length) await v.be.discard(st.unstaged)
                },
                { statusOnly: true },
              ),
            ),
        },
      ]
    } else if (view.data.stashes.some((s) => s.oid === c.id)) {
      const s = view.data.stashes.find((s) => s.oid === c.id)!
      items = stashItems(s.index, s.message)
    } else {
      const refs = view.data.refsByOid.get(c.id) ?? []
      const isHead = view.data.headOid === c.id
      for (const l of refs) {
        if (l.kind === 'head') items.push(...branchItems(l.name, c.id, l.current ?? false).filter((i) => i.label !== 'New branch from here'))
        if (l.kind === 'remote') items.push(...remoteItems(l.name))
        if (l.kind === 'tag') items.push(...tagItems(l.name, c.id))
        items.push({ sep: true })
      }
      if (!isHead) items.push({ label: 'Check out here (no branch)', onClick: () => run('Checking out', () => v.be.checkoutCommit(c.id)) })
      items.push({ label: 'New branch from here', onClick: () => setDialog({ kind: 'branch', at: c.id }) })
      items.push({ label: 'New tag here', onClick: () => setDialog({ kind: 'tag', at: c.id }) })
      if (head && !isHead) {
        items.push({ sep: true })
        if (v.be.rebase) items.push({ label: `Rebase ${head} here`, onClick: () => rebaseOnto(c.id) })
        if (v.be.cherryPick) items.push({ label: 'Cherry-pick this commit', onClick: () => run('Cherry-picking', () => v.be.cherryPick!(c.id), { after: conflictToast }) })
        items.push({ label: `Reset ${head} to this commit...`, onClick: () => setDialog({ kind: 'reset', at: c.id }) })
      }
      if (head && v.be.revert) items.push({ label: 'Revert this commit', onClick: () => run('Reverting', () => v.be.revert!(c.id), { after: conflictToast }) })
      items.push({ sep: true })
      items.push({ label: 'Copy full hash', onClick: () => copy(c.id) })
    }
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const fileMenu = (e: MouseEvent, f: FileChange, area: DiffArea) => {
    const v = view!
    const items: MenuItem[] = []
    if (area.kind === 'unstaged') items.push({ label: 'Stage', onClick: () => run('Staging', () => v.be.stage([f]), { statusOnly: true }) })
    if (area.kind === 'staged') items.push({ label: 'Unstage', onClick: () => run('Unstaging', () => v.be.unstage([f.path]), { statusOnly: true }) })
    if (v.be.openPath && f.kind !== 'D') items.push({ label: 'Open file', onClick: () => v.be.openPath!(f.path).catch((err) => fail('Could not open the file', err)) })
    items.push({ label: 'Copy path', onClick: () => copy(f.path) })
    if (area.kind === 'unstaged') {
      items.push({ sep: true })
      items.push({ label: 'Throw away changes', danger: true, onClick: () => discardFiles([f]) })
    }
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const discardFiles = (files: FileChange[]) => {
    const v = view!
    const what = files.length === 1 ? `Unstaged edits to "${files[0].path}" will be lost. Continue?` : `Unstaged edits to ${files.length} files will be lost. Continue?`
    confirm(what, () => run('Discarding', () => v.be.discard(files), { statusOnly: true }))
  }

  const actionsFor = (f: FileSel): ChunkAction[] => {
    const v = view
    if (!v || f.area.kind === 'commit') return []
    const list = f.area.kind === 'staged' ? v.data.status.staged : v.data.status.unstaged
    if (list.find((x) => x.path === f.path)?.kind !== 'M') return []
    if (f.area.kind === 'staged') return [{ label: 'Unstage this change', icon: 'remove', into: 'b', run: (t, base) => run('Unstaging chunk', () => v.be.writeIndex(f.path, t, base), { statusOnly: true }) }]
    return [
      { label: 'Stage this change', icon: 'add', into: 'a', run: (t, base) => run('Staging chunk', () => v.be.writeIndex(f.path, t, base), { statusOnly: true }) },
      {
        label: 'Discard this change',
        icon: 'discard',
        into: 'b',
        run: (t, base) => confirm(`This change in "${f.path}" will be reverted in the working tree. Continue?`, () => run('Discarding chunk', () => v.be.writeWorkdir(f.path, t, base), { statusOnly: true })),
      },
    ]
  }
  const saveFile = (f: FileSel, text: string, base: string, done: () => void) => {
    const v = view
    if (v) run('Saving', () => v.be.writeWorkdir(f.path, text, base), { statusOnly: true, after: done })
  }
  const activeTab = diffTabs.find((t) => t.key === activeDiff) ?? diffTabs[0]
  const fileSel = activeTab?.sel
  const showTab = (key: string) => {
    setActiveDiff(key)
    setOnGraph(false)
  }
  const openFile = (f: FileSel) => {
    const key = tabKey(f)
    setDiffTabs((ts) => (ts.some((t) => t.key === key) ? ts : [...ts, { key, sel: f, dirty: false }]))
    showTab(key)
  }
  const openPr = (pr: PullRequest) => {
    const key = `pr:${pr.number}`
    setDiffTabs((ts) => (ts.some((t) => t.key === key) ? ts : [...ts, { key, sel: { area: { kind: 'unstaged' }, path: `#${pr.number}` }, dirty: false, pr }]))
    showTab(key)
  }
  const openWorkFile = (path: string) => {
    const key = `file:${path}`
    setDiffTabs((ts) => (ts.some((t) => t.key === key) ? ts : [...ts, { key, sel: { area: { kind: 'unstaged' }, path }, dirty: false, file: true }]))
    showTab(key)
  }
  const dropTab = (key: string) => {
    const i = diffTabs.findIndex((t) => t.key === key)
    const rest = diffTabs.filter((t) => t.key !== key)
    setDiffTabs((ts) => ts.filter((t) => t.key !== key))
    if (activeTab?.key === key) setActiveDiff(rest[Math.min(i, rest.length - 1)]?.key)
  }
  const closeTab = (key: string) => {
    const t = diffTabs.find((x) => x.key === key)
    if (t?.dirty) confirm(`Unsaved edits to "${t.sel.path}" will be lost. Continue?`, () => dropTab(key))
    else dropTab(key)
  }
  const closeAllTabs = () => {
    const dirtyCount = diffTabs.filter((t) => t.dirty).length
    if (dirtyCount) confirm(`Unsaved edits in ${dirtyCount} file${dirtyCount === 1 ? '' : 's'} will be lost. Continue?`, () => setDiffTabs([]))
    else setDiffTabs([])
  }
  const anyDirty = diffTabs.some((t) => t.dirty)
  useEffect(() => p.onDirty(anyDirty), [anyDirty])
  const setTabDirty = (key: string, d: boolean) => setDiffTabs((ts) => ts.map((t) => (t.key === key && t.dirty !== d ? { ...t, dirty: d } : t)))

  const switchRemote = (name: string) => {
    const v = view
    if (!v) return
    const commits = (k = 0) => `${k} commit${k === 1 ? '' : 's'}`
    run('Switching branch', () => v.be.checkoutRemote(name), {
      after: (x) => {
        const r = x as RemoteSwitch | void
        if (!r) return
        const said =
          r.result === 'created'
            ? `Switched to ${r.local}, a new branch tracking ${name}.`
            : r.result === 'updated'
              ? `Switched to ${r.local} and brought in ${commits(r.behind)} from ${name}.`
              : r.result === 'diverged'
                ? `Switched to ${r.local}. It has ${commits(r.ahead)} that ${name} doesn't, so it was not updated. Pull to combine them.`
                : `Switched to ${r.local}, already up to date with ${name}.`
        setToast(r.stash === 'conflicts' ? `${said} Your uncommitted changes conflicted when they were put back.` : r.stash === 'kept' ? `${said} Your uncommitted changes came along.` : said)
      },
    })
  }

  const pillDoubleClick = (pill: PillData) => {
    if (!view) return
    if (pill.local && !pill.current) run('Switching branch', () => view.be.checkoutBranch(pill.local!.name))
    else if (pill.remote && !pill.local) switchRemote(pill.remote!.name)
  }

  const onDrop = ({ source, rowIndex, x, y }: DropInfo) => {
    const v = view!
    const c = v.rows[rowIndex]
    const refs = v.data.refsByOid.get(c.id) ?? []
    const targetHead = refs.find((l) => l.kind === 'head' && l.current)
    const targetRef = refs.find((l) => l.kind === 'head') ?? refs.find((l) => l.kind === 'remote')
    const targetName = targetRef?.name ?? short(c.id)
    const srcName = source.local?.name ?? source.remote!.name
    const items: MenuItem[] = []
    if (targetHead && srcName !== targetHead.name) items.push({ label: `Merge ${srcName} into ${targetHead.name}`, onClick: () => mergeInto(srcName) })
    if (source.current && head && c.id !== v.data.headOid) {
      if (v.be.rebase) items.push({ label: `Rebase ${head} onto ${targetName}`, onClick: () => rebaseOnto(targetRef?.name ?? c.id) })
      items.push({ label: `Reset ${head} to ${targetName}...`, onClick: () => setDialog({ kind: 'reset', at: c.id }) })
    }
    if (!source.current && !targetHead) items.push({ label: `Switch to ${srcName} first to rebase it, or drop onto ${head ?? 'the checked-out branch'} to merge` })
    setMenu({ x, y, items })
  }

  const commands = useMemo<Command[]>(() => {
    if (!view) return []
    const v = view
    const list: Command[] = [
      { id: 'fetch', group: 'Action', label: 'Fetch every remote', hint: '⌘L', run: () => run('Fetch', () => v.be.fetchAll(), { after: () => setToast('Fetch done') }) },
      { id: 'pull', group: 'Action', label: 'Pull', run: () => head && run('Pull', () => v.be.pull(pullMode, head), { after: () => setToast('Pull done') }) },
      ...(v.be.native ? (Object.keys(PULL_MODES) as PullMode[]).map((m) => ({ id: `pullmode:${m}`, group: 'Action', label: `Pull mode: ${PULL_MODES[m]}${m === pullMode ? ' (current)' : ''}`, run: () => setPullMode(m) })) : []),
      { id: 'push', group: 'Action', label: 'Push', run: () => pushHead() },
      { id: 'branch', group: 'Action', label: 'New branch from HEAD', hint: '⌘B', run: () => v.data.headOid && setDialog({ kind: 'branch', at: v.data.headOid }) },
      { id: 'stash', group: 'Action', label: 'Stash everything', run: () => setDialog({ kind: 'stash' }) },
      { id: 'pop', group: 'Action', label: 'Apply and drop the newest stash', run: () => run('Applying stash', () => v.be.stashApply(0, true)) },
      { id: 'stageall', group: 'Action', label: 'Stage everything', hint: '⌘⇧S', run: () => run('Staging', () => v.be.stage(v.data.status.unstaged), { statusOnly: true }) },
      { id: 'unstageall', group: 'Action', label: 'Unstage everything', hint: '⌘⇧U', run: () => run('Unstaging', () => v.be.unstage(v.data.status.staged.map((f) => f.path)), { statusOnly: true }) },
      { id: 'refresh', group: 'View', label: 'Refresh', run: () => reload() },
      { id: 'left', group: 'View', label: 'Toggle the left panel', hint: '⌘J', run: () => setShowLeft((s) => !s) },
      { id: 'theme', group: 'View', label: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme', run: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
      { id: 'scheme', group: 'View', label: 'Use a color scheme from a link…', run: () => setDialog({ kind: 'scheme' }) },
      { id: 'tree', group: 'View', label: tree ? 'Show files as a flat list' : 'Show files as a tree', run: () => setTree(!tree) },
      { id: 'keys', group: 'View', label: 'Keyboard shortcuts', hint: '?', run: () => setShortcuts(true) },
      { id: 'repos', group: 'View', label: 'Search open repositories', hint: '⌘⇧A', run: p.onSearchRepos },
      { id: 'pullall', group: 'Action', label: 'Pull every open repository (fast-forward only)', run: () => p.onAll('pull') },
      { id: 'fetchall', group: 'Action', label: 'Fetch every open repository', run: () => p.onAll('fetch') },
    ]
    list.push(...aiCommands())
    if (solo.size) list.push({ id: 'unsolo', group: 'View', label: 'Show all branches', run: () => setSolo(new Set()) })
    list.push({ id: 'open', group: 'Action', label: 'Open repository…', run: p.onOpenRepo })
    for (const b of v.data.local) {
      if (!b.isHead) list.push({ id: `sw:${b.name}`, group: 'Branch', label: `Switch to ${b.name}`, run: () => run('Switching branch', () => v.be.checkoutBranch(b.name)) })
      list.push({ id: `solo:${b.name}`, group: 'Branch', label: `Solo ${b.name}`, run: () => toggleSolo(b.name) })
      list.push({ id: `jump:${b.name}`, group: 'Branch', label: `Jump to ${b.name}`, run: () => jump(b.oid) })
    }
    for (const b of v.data.remote) list.push({ id: `swr:${b.name}`, group: 'Remote', label: `Switch to ${b.name}`, run: () => switchRemote(b.name) })
    for (const t of v.data.tags) list.push({ id: `tag:${t.name}`, group: 'Tag', label: `Jump to ${t.name}`, run: () => jump(t.oid) })
    return list
  }, [view, head, pullMode, theme, tree, solo, aiInfo, aiReady, terms, drawerShown])

  useEffect(() => {
    if (!p.active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`' && p.be.termStart) {
        e.preventDefault()
        toggleAgent()
        return
      }
      if (e.target instanceof Element && e.target.closest('.diff-pane, .agent-drawer')) return
      const mod = e.metaKey || e.ctrlKey
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable)
      if (mod && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        if (view) openPalette(!palette)
      } else if (mod && e.key === 'f') {
        e.preventDefault()
        filterRef.current?.focus()
      } else if (mod && e.key === 'b' && view?.data.headOid) {
        e.preventDefault()
        setDialog({ kind: 'branch', at: view.data.headOid })
      } else if (mod && e.key === 'l' && view) {
        e.preventDefault()
        run('Fetch', () => view.be.fetchAll(), { after: () => setToast('Fetch done') })
      } else if (mod && e.key === 'Enter') {
        e.preventDefault()
        doCommit()
      } else if (mod && e.shiftKey && (e.key === 's' || e.key === 'S') && view) {
        e.preventDefault()
        run('Staging', () => view.be.stage(view.data.status.unstaged), { statusOnly: true })
      } else if (mod && e.shiftKey && (e.key === 'u' || e.key === 'U') && view) {
        e.preventDefault()
        run('Unstaging', () => view.be.unstage(view.data.status.staged.map((f) => f.path)), { statusOnly: true })
      } else if (mod && e.key === 'j') {
        e.preventDefault()
        setShowLeft((s) => !s)
      } else if (e.key === 'Escape') {
        if (palette) openPalette(false)
        else if (shortcuts) setShortcuts(false)
        else if (dialog && !aiDialog) closeDialog()
        else if (filter) setFilter('')
        else if (solo.size) setSolo(new Set())
      } else if (!typing && !dialog && !palette && !overlayRef.current) {
        if (e.key === '?') {
          e.preventDefault()
          setShortcuts(true)
        } else if (view && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k')) {
          e.preventDefault()
          const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1
          const pos = order.indexOf(selectedIndex)
          const next = order[Math.min(order.length - 1, Math.max(0, pos + step))]
          if (next !== undefined) {
            select(next)
            setScrollTo(next)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const statusBar = (v?: View) => {
    const cur = v?.data.local.find((b) => b.isHead)
    const changes = v ? new Set([...v.data.status.staged, ...v.data.status.unstaged].map((f) => f.path)).size : 0
    return (
      <div class="statusbar">
        {v && (
          <>
            {!head && <span>{v.data.headOid ? 'Detached HEAD' : 'No commits yet'}</span>}
            {cur?.upstream ? (
              <span title={`Compared with ${cur.upstream}`}>
                <Icon name="sync" />
                {cur.behind ?? 0}
                <Icon name="arrow-small-down" />
                {cur.ahead ?? 0}
                <Icon name="arrow-small-up" />
              </span>
            ) : (
              head && <span>no upstream</span>
            )}
            {changes > 0 && (
              <span class="warn" title={`${changes} uncommitted change${changes === 1 ? '' : 's'}`}>
                <Icon name="source-control" />
                {changes}
              </span>
            )}
            {v.data.stashes.length > 0 && (
              <span title={`${v.data.stashes.length} stash${v.data.stashes.length === 1 ? '' : 'es'}`}>
                <Icon name="git-stash" />
                {v.data.stashes.length}
              </span>
            )}
          </>
        )}
        <span class="spacer" />
        {updatedAt && (
          <button onClick={() => reload()} title={`Updated ${updatedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. Refresh now`} aria-label="Refresh">
            <Icon name="refresh" />
          </button>
        )}
        {v && (
          <button onClick={() => openPalette(true)} title="Commands (⌘⇧P)" aria-label="Commands">
            <Icon name="list-selection" />
          </button>
        )}
        <button onClick={() => setShortcuts(true)} title="Keyboard shortcuts (?)">
          <Icon name="keyboard" />
        </button>
        <button onClick={themeMenu} title="Theme and color scheme" aria-label="Theme and color scheme">
          <Icon name="color-mode" />
        </button>
      </div>
    )
  }

  const drawer = activeTerm && drawerShown && p.active && (

    <div class="agent-drawer" style={drawerMax ? undefined : { height: `${drawerH}px` }}>
      {!drawerMax && <Splitter horizontal onDrag={(dy) => setDrawerH((h) => clamp(h - dy, 120, innerHeight - 200))} />}
      <div class="drawer-head">
        <div class="term-tabs" role="tablist" aria-label="Agent and terminal tabs">
          {terms.map((t) => (
            <div
              key={t.id}
              role="tab"
              tabIndex={0}
              aria-selected={t.id === activeTerm.id}
              class={`term-tab ${t.id === activeTerm.id ? 'active' : ''} ${termRunning[t.id] === false ? 'stopped' : ''} ${termTitle(t).busy ? 'busy' : ''}`}
              title={termRunning[t.id] === false ? `${termLabel(t)} (stopped)` : termLabel(t)}
              onClick={() => showTerm(t.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && showTerm(t.id)}
            >
              <Icon name={t.kind === 'shell' ? 'terminal' : termTitle(t).busy ? 'loading' : 'sparkle'} />
              <span class="label">{termLabel(t)}</span>
              <button
                class="icon"
                title="Close this tab"
                aria-label={`Close ${termLabel(t)}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerm(t.id)
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          <button class="icon" title="New agent or terminal tab" aria-label="New agent or terminal tab" onClick={newTermMenu}>
            <Icon name="add" />
          </button>
        </div>
        <span class="spacer" />
        <button class="icon" title={`Restart this ${activeTerm.kind === 'shell' ? 'terminal' : 'agent'}`} aria-label="Restart this tab" onClick={() => setRestart((r) => ({ tab: activeTerm.id, n: r.n + 1 }))}>
          <Icon name="debug-restart" />
        </button>
        <button class="icon" title="AI agent settings" aria-label="AI agent settings" onClick={openAiSettings}>
          <Icon name="settings-gear" />
        </button>
        <button class="icon" title={drawerMax ? 'Restore the panel' : 'Maximize the panel'} aria-label={drawerMax ? 'Restore the panel' : 'Maximize the panel'} onClick={() => setDrawerMax((m) => !m)}>
          <Icon name={drawerMax ? 'screen-normal' : 'screen-full'} />
        </button>
        <button class="icon" title="Hide the panel (⌃`)" aria-label="Hide the panel" onClick={() => setDrawerShown(false)}>
          <Icon name="chevron-down" />
        </button>
      </div>
      <AgentTerminal
        key={activeTerm.id}
        be={p.be}
        id={activeTerm.id}
        kind={activeTerm.kind}
        agent={activeTerm.agent}
        look={look}
        focus={termFocus}
        onFocused={() => setTermFocus(false)}
        paste={paste?.tab === activeTerm.id ? paste : undefined}
        restart={restart.tab === activeTerm.id ? restart.n : 0}
        onState={(st) => setTermRunning((m) => ({ ...m, [activeTerm.id]: st.running }))}
        onPasted={() => setPaste(undefined)}
      />
    </div>
  )
  const drawerCls = `${terms.length && drawerShown ? 'with-drawer' : ''} ${terms.length && drawerShown && drawerMax ? 'drawer-max' : ''}`
  const initRepo = () =>
    p.be.init!().then(
      () => openBackend(p.be),
      (e) => fail('Could not start a repository', e),
    )
  const aiDialogs = (
    <>
      {aiDialog === 'consent' && aiInfo && <AiConsent agents={aiInfo.agents} onAnswer={answerConsent} />}
      {aiDialog === 'settings' && aiInfo && (
        <AiSettingsDialog
          info={aiInfo}
          onClose={() => setAiDialog(undefined)}
          onSave={(settings) =>
            p.be
              .setAi!(settings)
              .then(() => setAiInfo({ ...aiInfo, settings }))
              .catch((e) => fail('Could not save the AI settings', e))
          }
        />
      )}
    </>
  )

  if (!view) {
    return (
      <div class={`app ${drawerCls}`}>
        <div class="toolbar">
          {noGit && (
            <>
              <div class="tb-side">
                <BrandMark />
                <span class="repo">{p.name}</span>
              </div>
              <div />
              <div class="tb-side tb-end">
                <SidebarToggle on={p.sidebar} onToggle={p.onToggleSidebar} />
                {p.be.termStart && (
                  <button class={`ai-btn ${drawerShown ? 'on' : ''}`} onClick={toggleAgent} title="Agent and terminals (⌃`)" aria-pressed={drawerShown}>
                    <Icon name="sparkle" />
                    Agent
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {noGit ? (
          <div class="placeholder no-git">
            <Icon name="folder-opened" />
            <div class="ng-name">{p.name}</div>
            <div class="ng-note">No git repository yet</div>
            <div class="ng-acts">
              {p.be.init && (
                <button class="primary" onClick={initRepo}>
                  <Icon name="git-branch-create" />
                  Initialize git
                </button>
              )}
              {p.be.termStart && (
                <>
                  <button class="secondary" onClick={() => void openAgent()}>
                    <Icon name="sparkle" />
                    Agent
                  </button>
                  <button class="secondary" onClick={() => void addTerm('shell')}>
                    <Icon name="terminal" />
                    Terminal
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div class="placeholder">{busy ? `${busy}...` : 'This repository could not be read.'}</div>
        )}
        {drawer}
        {statusBar()}
        {menu && <Menu menu={menu} onClose={() => setMenu(undefined)} />}
        {shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}
        {dialog && <Dialogs dialog={dialog} settings={settings} native={p.be.native} onClose={() => setDialog(undefined)} onCreateBranch={() => {}} onCreateTag={() => {}} onRename={() => {}} onStash={() => {}} onReset={() => {}} onSettings={() => {}} onScheme={p.onScheme} />}
        {aiDialogs}
        {toast && <div class="toast">{toast}</div>}
      </div>
    )
  }

  const v = view
  const current = sel?.kind === 'commit' ? v.rows[v.indexOf.get(sel.oid) ?? -1] : undefined
  const layoutOf = (i: number) => soloInfo?.layoutByIndex.get(i) ?? v.layout[i]
  const currentColor = current ? laneColor(layoutOf(v.indexOf.get(current.id)!).column) : 'var(--lane-0)'
  const wipCount = new Set([...v.data.status.staged, ...v.data.status.unstaged].map((f) => f.path)).size
  const branchOf = (r: { name: string; kind: string }) => (r.kind === 'head' ? r.name : r.kind === 'remote' ? r.name.slice(r.name.indexOf('/') + 1) : '')
  const shownPr =
    sel?.kind === 'commit'
      ? (v.data.refsByOid.get(sel.oid) ?? []).map((r) => prs.get(branchOf(r))).find(Boolean)
      : v.data.headBranch
        ? prs.get(v.data.headBranch)
        : undefined
  const net = (label: string, fn: () => Promise<unknown>) => run(label, fn, { after: () => setToast(`${label} done`) })
  const changePr = (pr: PullRequest, action: PrChange) =>
    run(`${CHANGE_LABEL[action][0]} #${pr.number}`, async () => {
      try {
        await v.be.prChange!(pr.number, action)
      } catch (e) {
        return fail(`GitHub did not change #${pr.number}`, e)
      }
      setToast(`#${pr.number} ${CHANGE_LABEL[action][1]}`)
    })
  const mergePr = (pr: PullRequest) =>
    setDialog({
      kind: 'pr-merge',
      number: pr.number,
      title: pr.title,
      last: p.mergeMethod,
      merge: (method) => {
        p.onMergeMethod(method)
        return run(`Merging #${pr.number} on GitHub`, async () => {
          try {
            await v.be.prMerge!(pr.number, method)
          } catch (e) {
            return fail(`GitHub did not merge #${pr.number}`, e)
          }
          setToast(`Merged #${pr.number} on GitHub`)
          await v.be.fetchAll()
        })
      },
    })

  return (
    <div class={`app ${drawerCls}`}>
      <div class="toolbar">
        <div class="tb-side">
          <BrandMark />
          <span class="repo">{v.data.name}</span>
          <button
            class={`branch ${v.data.headBranch ? '' : 'detached'}`}
            disabled={v.data.local.length === 0}
            onClick={() => openPalette('branches')}
            title={v.data.headBranch ? `Checked out: ${v.data.headBranch}. Click to switch.` : 'Not on a branch. Click to switch to one.'}
          >
            <Icon name="git-branch" />
            <span class="name">{v.data.headBranch ?? (v.data.headOid ? `detached at ${v.data.headOid.slice(0, 7)}` : 'no commits')}</span>
            <Icon name="chevron-down" />
          </button>
          {busy && <span class="busy">{busy}...</span>}
        </div>
        <div class="tb-actions" role="toolbar" aria-label="Repository actions">
          <span class="split">
            <button class="tool" disabled={!!busy || !head} onClick={() => net('Pull', () => v.be.pull(pullMode, head!))} title={v.be.native ? `Pull (${PULL_MODES[pullMode]})` : 'Pull'}>
              <Icon name="arrow-circle-down" />
              <span class="tl">Pull</span>
            </button>
            {v.be.native && (
              <button
                class="tool tb-more"
                disabled={!!busy || !head}
                title="How pull integrates changes"
                aria-label="Pull options"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setMenu({ x: r.left - 34, y: r.bottom + 4, items: (Object.keys(PULL_MODES) as PullMode[]).map((m) => ({ label: PULL_MODES[m], checked: m === pullMode, onClick: () => setPullMode(m) })) })
                }}
              >
                <Icon name="chevron-down" />
              </button>
            )}
          </span>
          <button class="tool" disabled={!!busy || !head} onClick={() => pushHead()} title="Push the checked-out branch">
            <Icon name="arrow-circle-up" />
            <span class="tl">Push</span>
          </button>
          <button class="tool" disabled={!!busy} onClick={() => net('Fetch', () => v.be.fetchAll())} title="Fetch every remote (⌘L)">
            <Icon name="cloud-download" />
            <span class="tl">Fetch</span>
          </button>
          <span class="sep" />
          <button class="tool" disabled={!!busy || !v.data.headOid} onClick={() => setDialog({ kind: 'branch', at: v.data.headOid! })} title="New branch (⌘B)">
            <Icon name="git-branch-create" />
            <span class="tl">Branch</span>
          </button>
          <span class="split">
            <button class="tool" disabled={!!busy || wipCount === 0} onClick={() => setDialog({ kind: 'stash' })} title="Stash everything">
              <Icon name="git-stash" />
              <span class="tl">Stash</span>
            </button>
            <button
              class="tool tb-more"
              disabled={!!busy || v.data.stashes.length === 0}
              title="Put the newest stash back"
              aria-label="Stash options"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setMenu({ x: r.left - 34, y: r.bottom + 4, items: [{ label: 'Apply and drop the newest stash', onClick: () => run('Applying stash', () => v.be.stashApply(0, true)) }] })
              }}
            >
              <Icon name="chevron-down" />
            </button>
          </span>
        </div>
        <div class="tb-side tb-end">
          <span class="search">
            <Icon name="search" />
            <input ref={filterRef} placeholder="Search commits (⌘F)" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          </span>
          {filter && <span class="busy">{order.length} results</span>}
          <SidebarToggle on={p.sidebar} onToggle={p.onToggleSidebar} />
          <button class={`icon ${showLeft ? 'on' : ''}`} onClick={() => setShowLeft(!showLeft)} title="Toggle left panel (⌘J)">
            <Icon name={showLeft ? 'layout-sidebar-left' : 'layout-sidebar-left-off'} />
          </button>
          {!v.be.native && (
            <button class="icon" onClick={() => setDialog({ kind: 'settings' })} title="Settings: author and remote access">
              <Icon name="settings-gear" />
            </button>
          )}
          <BrandLinks />
          <button class={`ai-btn ${drawerShown ? 'on' : ''}`} onClick={toggleAgent} title="Your AI agent and terminals (⌃`)" aria-pressed={drawerShown}>
            <Icon name="sparkle" />
            Agent
          </button>
        </div>
      </div>
      <div class={`body ${showLeft ? '' : 'no-left'}`} style={{ '--left-w': `${leftW}px` }}>
        <LeftPanel
          data={v.data}
          columnOf={(oid) => {
            const i = v.indexOf.get(oid)
            return i === undefined ? undefined : layoutOf(i)?.column
          }}
          selectedOid={sel?.kind === 'commit' ? sel.oid : undefined}
          solo={solo}
          onToggleSolo={toggleSolo}
          onJump={jump}
          onCheckout={(name) => run('Switching branch', () => v.be.checkoutBranch(name))}
          onCheckoutRemote={(name) => switchRemote(name)}
          onBranchMenu={(e, name, oid, isHead) => setMenu({ x: e.clientX, y: e.clientY, items: branchItems(name, oid, isHead) })}
          onRemoteMenu={(e, name) => setMenu({ x: e.clientX, y: e.clientY, items: remoteItems(name) })}
          onTagMenu={(e, name, oid) => setMenu({ x: e.clientX, y: e.clientY, items: tagItems(name, oid) })}
          onStashMenu={(e, index, message) => setMenu({ x: e.clientX, y: e.clientY, items: stashItems(index, message) })}
          loadFiles={() => v.be.files()}
          stamp={v}
          selectedFile={activeTab?.file ? activeTab.sel.path : undefined}
          onOpenFile={openWorkFile}
          prs={prs}
          onMergePr={v.be.prMerge ? mergePr : undefined}
          onOpenPr={v.be.prView ? openPr : undefined}
          mode={leftMode}
          onMode={setLeftMode}
          detail={
            <DetailPanel
              top={
                shownPr && v.be.prView ? (
                  <PrCard key={shownPr.number} be={v.be} pr={shownPr} active={p.active} stamp={v} busy={!!busy} onOpen={openPr} onMerge={v.be.prMerge ? mergePr : undefined} onChange={v.be.prChange ? changePr : undefined} />
                ) : undefined
              }
              data={v.data}
              commit={current}
              commitColor={currentColor}
              commitFiles={commitFiles}
              isStash={!!current && v.data.stashes.some((s) => s.oid === current.id)}
              selectedFile={fileSel}
              tree={tree}
              summary={summary}
              description={description}
              amend={amend}
              onTree={setTree}
              onSummary={setSummary}
              onDescription={setDescription}
              onAmend={setAmend}
              onSelectFile={openFile}
              onStage={(files) => run('Staging', () => v.be.stage(files), { statusOnly: true })}
              onUnstage={(paths) => run('Unstaging', () => v.be.unstage(paths), { statusOnly: true })}
              onDiscard={discardFiles}
              onStageAll={() => run('Staging', () => v.be.stage(v.data.status.unstaged), { statusOnly: true })}
              onUnstageAll={() => run('Unstaging', () => v.be.unstage(v.data.status.staged.map((f) => f.path)), { statusOnly: true })}
              onCommit={doCommit}
              onCopy={copy}
              onJump={jump}
              onFileMenu={fileMenu}
              onAbort={v.be.abort ? () => run('Aborting', () => v.be.abort!(), { after: () => setUndo(undefined) }) : undefined}
              onDropAutostash={v.be.dropAutostash ? () => run('Dropping the saved copy', () => v.be.dropAutostash!()) : undefined}
              onContinue={v.be.continueOp ? () => run('Continuing', () => v.be.continueOp!()) : undefined}
              onAiCommit={aiReady ? () => aiDraft('commit') : undefined}
              aiDrafting={drafting === 'commit'}
              onAiFix={aiReady && p.be.termStart ? (path) => openAgent(path) : undefined}
            />
          }
        />
        <Splitter onDrag={(dx) => setLeftW((w) => clamp(w + dx, 240, 760))} />
        <GraphView
          rows={v.rows}
          layoutOf={layoutOf}
          maxCol={soloInfo?.maxCol ?? v.maxCol}
          refsByOid={v.data.refsByOid}
          branches={v.data.local}
          order={order}
          showEdges={filter.trim().length === 0}
          selectedIndex={selectedIndex}
          scrollTo={scrollTo}
          wipCount={wipCount}
          hasMore={v.data.hasMore && !soloInfo}
          soloCount={solo.size}
          onSelect={(i) => {
            select(i)
            setLeftMode('commit')
          }}
          onContextMenu={rowMenu}
          onPillDoubleClick={pillDoubleClick}
          onDrop={onDrop}
          onLoadMore={() => run('Loading more', async () => applyData(v.be, await v.be.load(v.limit + PAGE), v.limit + PAGE, false))}
          onScrolled={() => setScrollTo(undefined)}
          onClearSolo={() => setSolo(new Set())}
        />
        {activeTab && (
          <DiffWindow
            tabs={diffTabs}
            active={activeTab.key}
            shown={p.active}
            be={v.be}
            stamp={v}
            options={diffOptions}
            look={look}
            actionsFor={actionsFor}
            onActivate={showTab}
            onGraph={onGraph}
            onShowGraph={() => setOnGraph(true)}
            onCloseTab={closeTab}
            onCloseAll={closeAllTabs}
            onOptions={setDiffOptions}
            onDirty={setTabDirty}
            onSave={saveFile}
            onOpen={v.be.openPath ? (f) => v.be.openPath!(f.path).catch((err) => fail('Could not open the file', err)) : undefined}
            onMergePr={v.be.prMerge ? mergePr : undefined}
            onChangePr={v.be.prChange ? changePr : undefined}
            busy={!!busy}
          />
        )}
      </div>
      {drawer}
      {statusBar(v)}
      {menu && <Menu menu={menu} onClose={() => setMenu(undefined)} />}
      {palette && (
        <Palette
          commands={palette === 'branches' ? commands.filter((c) => c.id.startsWith('sw:') || c.id.startsWith('swr:')) : commands}
          placeholder={palette === 'branches' ? 'Switch to a branch' : undefined}
          onClose={() => openPalette(false)}
        />
      )}
      {shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}
      {dialog && (
        <Dialogs
          dialog={dialog}
          settings={settings}
          native={v.be.native}
          onClose={closeDialog}
          onCreateBranch={(name, at, checkout) => run('Creating branch', () => v.be.createBranch(name, at, checkout))}
          onCreateTag={(name, at, message) => run('Creating tag', () => v.be.createTag(name, at, message))}
          onRename={(old, name) => run('Renaming branch', () => v.be.renameBranch(old, name))}
          onStash={(message) => run('Stashing', () => v.be.stashSave(message))}
          onReset={(at, mode) => head && run('Resetting', () => v.be.reset(head, at, mode))}
          onSettings={(s) => {
            setSettings(s)
            saveSettings(s)
          }}
          onSuggestBranch={aiReady ? (at) => aiDraft('branch', at) : undefined}
          onScheme={p.onScheme}
          suggesting={drafting === 'branch'}
        />
      )}
      {aiDialogs}
      {undo && v.data.status.state !== 'rebase' && (
        <div class="undo-bar" role="status">
          <Icon name="history" />
          <span>Rebased onto {undo.onto}</span>
          <button class="secondary" onClick={undoRebase}>
            Undo rebase
          </button>
          <button class="icon" title="Dismiss" aria-label="Dismiss" onClick={() => setUndo(undefined)}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {toast && <div class="toast">{toast}</div>}
    </div>
  )
}
