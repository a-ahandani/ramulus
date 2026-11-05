import { get, set } from 'idb-keyval'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { FsaFs } from '../fs/fsa'
import type { Backend, MergeMethod } from '../git/backend'
import { demoRepo } from '../git/demo'
import { helperShell, httpBackend, type RepoInfo } from '../git/remote'
import { localBackend } from '../git/repo'
import { isScheme, schemeVars, type Scheme } from '../git/scheme'
import { App, loadSettings, type TabApi, type Theme } from './App'
import { BrandLinks, BrandMark, Icon, cannotFastForward, settleLimited } from './bits'
import { Dialogs, type Dialog } from './Dialogs'
import { Menu, type MenuState } from './Menu'
import { Palette, type Command } from './Palette'
import { Sidebar, type RepoSummary, type SideRecent } from './Sidebar'
import { Splitter } from './Splitter'

interface Tab {
  id: number
  key: string
  name: string
  title: string
  be: Backend
  pinned: boolean
  handle?: FileSystemDirectoryHandle
}

const canPick = typeof window !== 'undefined' && 'showDirectoryPicker' in window
const token = typeof location !== 'undefined' && /^#[0-9a-f]{32}$/.test(location.hash) ? location.hash.slice(1) : undefined
const helper = token ? helperShell(location.origin, token) : undefined
const looksLikePath = /^(~|\/|\.|[A-Za-z]:[\\/]|\\\\)/

let nextId = 1

function reason(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  if (cannotFastForward(text)) return 'has local commits the remote does not have, so it cannot fast-forward. Pull it on its own to merge or rebase.'
  if (/no tracking information|no upstream/i.test(text)) return 'its branch has no upstream to pull from.'
  if (/No remote repository specified|does not appear to be a git repository|No such remote/i.test(text)) return 'it has no remote.'
  if (/would be overwritten/i.test(text)) return 'local changes would be overwritten. Commit or stash them first.'
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('hint:'))
  return (lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[lines.length - 1] ?? text).replace(/^(fatal|error):\s*/i, '')
}

function initialTheme(): Theme {
  const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem('ramulus.theme')
  return saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function initialScheme(): Scheme | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem('ramulus.scheme') ?? 'null')
    return isScheme(saved) ? saved : undefined
  } catch {
    return undefined
  }
}

const fallbackAuthor = () => {
  const s = loadSettings()
  return s.authorName && s.authorEmail ? { name: s.authorName, email: s.authorEmail } : undefined
}

const keepsSidebar = () => !!document.querySelector('.sidebar :focus-visible')

const ALL_AT_ONCE = 3
const sameSummary = (a: RepoSummary | undefined, b: RepoSummary) => !!a && a.branch === b.branch && a.changes === b.changes && a.ahead === b.ahead && a.behind === b.behind && a.busy === b.busy && a.noGit === b.noGit && a.agent === b.agent && a.ci === b.ci
const isMergeMethod = (m: unknown): m is MergeMethod => m === 'merge' || m === 'squash' || m === 'rebase'

export function Shell() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<number>()
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [scheme, setScheme] = useState<Scheme | undefined>(initialScheme)
  const applied = useRef<string[]>([])
  // the saved preferences, open repositories among them, are written only once they have been read
  const [prefsReady, setPrefsReady] = useState(!helper)
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>('merge')
  const [summaries, setSummaries] = useState<Record<number, RepoSummary>>({})
  const [menu, setMenu] = useState<MenuState>()
  const [picker, setPicker] = useState(false)
  const [recentRepos, setRecentRepos] = useState<RepoInfo[]>([])
  const [found, setFound] = useState<RepoInfo[]>([])
  const [handles, setHandles] = useState<FileSystemDirectoryHandle[]>([])
  const [dialog, setDialog] = useState<Dialog>()
  const [dirty, setDirty] = useState<Set<number>>(new Set())
  const [docked, setDocked] = useState(() => localStorage.getItem('ramulus.sidebar') !== 'auto')
  const [shown, setShown] = useState(false)
  const toggleDock = () => {
    setDocked((d) => !d)
    setShown(false)
  }
  const [sideW, setSideW] = useState(() => Number(localStorage.getItem('ramulus.sidebarw')) || 230)
  const [searchTick, setSearchTick] = useState(0)
  const [running, setRunning] = useState<string>()
  const [status, setStatus] = useState<string>()
  const apis = useRef(new Map<number, TabApi>())
  const pinnedKeys = useRef(new Set<string>())
  const runningRef = useRef(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const current = tabs.find((t) => t.id === active)
  const openKeys = tabs
    .slice(0, 50)
    .map((t) => t.key)
    .join('\n')

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.theme = scheme ? (scheme.dark ? 'dark' : 'light') : theme
    for (const k of applied.current) root.style.removeProperty(k)
    const vars = scheme ? schemeVars(scheme) : {}
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    applied.current = Object.keys(vars)
    try {
      localStorage.setItem('ramulus.theme', theme)
      if (scheme) localStorage.setItem('ramulus.scheme', JSON.stringify(scheme))
      else localStorage.removeItem('ramulus.scheme')
    } catch {}
    if (prefsReady) helper?.setPrefs({ theme, scheme: scheme ?? null, mergeMethod, open: openKeys.split('\n').filter(Boolean) }).catch(() => {})
  }, [theme, scheme, mergeMethod, openKeys, prefsReady])
  useEffect(() => {
    document.title = current ? `${current.name} · Ramulus` : 'Ramulus'
  }, [current])
  useEffect(() => {
    localStorage.setItem('ramulus.sidebar', docked ? 'docked' : 'auto')
    localStorage.setItem('ramulus.sidebarw', String(sideW))
  }, [docked, sideW])
  useEffect(() => {
    if (docked || !shown) return
    const away = (e: MouseEvent) => {
      if (e.clientX > sideW + 40 && !keepsSidebar() && !document.querySelector('.sidebar:hover')) setShown(false)
    }
    addEventListener('mousemove', away)
    return () => removeEventListener('mousemove', away)
  }, [docked, shown, sideW])
  useEffect(() => {
    if (!status) return
    const t = setTimeout(() => setStatus(undefined), 5000)
    return () => clearTimeout(t)
  }, [status])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'a') return
      e.preventDefault()
      searchRepos()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (dirty.size === 0) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    addEventListener('beforeunload', warn)
    return () => removeEventListener('beforeunload', warn)
  }, [dirty.size])

  const fail = (title: string, e: unknown) => setDialog({ kind: 'error', title, message: e instanceof Error ? e.message : String(e) })

  const add = (tab: Omit<Tab, 'id' | 'pinned'>, focus = true) => {
    const hit = tabsRef.current.find((t) => t.key === tab.key)
    if (hit) return focus && setActive(hit.id)
    const next = { ...tab, id: nextId++, pinned: pinnedKeys.current.has(tab.key) }
    tabsRef.current = [...tabsRef.current, next]
    setTabs(tabsRef.current)
    if (focus) setActive(next.id)
    else setActive((a) => a ?? next.id)
  }

  const reveal = () => {
    clearTimeout(hideTimer.current)
    setShown(true)
  }

  const conceal = () => {
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      if (!keepsSidebar() && !document.querySelector('.sidebar:hover')) setShown(false)
    }, 300)
  }

  const searchRepos = () => {
    reveal()
    setSearchTick((n) => n + 1)
  }

  const togglePin = (id: number) => {
    const t = tabsRef.current.find((x) => x.id === id)
    if (!t) return
    if (t.pinned) pinnedKeys.current.delete(t.key)
    else pinnedKeys.current.add(t.key)
    tabsRef.current = tabsRef.current.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x))
    setTabs(tabsRef.current)
    helper?.setPins([...pinnedKeys.current]).catch((e) => fail('Could not save pinned repositories', e))
  }

  const move = (id: number, target: number, after: boolean) => {
    const moved = tabsRef.current.find((t) => t.id === id)
    if (!moved || id === target) return
    const rest = tabsRef.current.filter((t) => t.id !== id)
    rest.splice(rest.findIndex((t) => t.id === target) + (after ? 1 : 0), 0, moved)
    tabsRef.current = rest
    setTabs(rest)
    if (!moved.pinned) return
    const open = rest.filter((t) => t.pinned).map((t) => t.key)
    pinnedKeys.current = new Set([...open, ...pinnedKeys.current])
    helper?.setPins([...pinnedKeys.current]).catch((e) => fail('Could not save pinned repositories', e))
  }

  const peekTerms = (id: number) => tabsRef.current.find((t) => t.id === id)?.be.termList?.().catch(() => []) ?? Promise.resolve([])

  const pickTerm = (id: number, term: string) => {
    setActive(id)
    apis.current.get(id)?.showTerm(term)
    if (!docked) setShown(false)
  }

  const runAll = async (kind: 'pull' | 'fetch') => {
    const list = tabsRef.current.flatMap((t) => {
      const api = apis.current.get(t.id)
      return api ? [{ t, api }] : []
    })
    if (list.length === 0 || runningRef.current) return
    runningRef.current = true
    const noun = (n: number) => `${n} ${n === 1 ? 'repository' : 'repositories'}`
    const verb = `${kind === 'pull' ? 'Pulling' : 'Fetching'} ${noun(list.length)}…`
    setRunning(verb)
    const results = await settleLimited(
      list.map((x) => () => x.api[kind]()),
      ALL_AT_ONCE,
      (done) => setRunning(`${verb} ${done} done`),
    )
    runningRef.current = false
    setRunning(undefined)
    const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${list[i].t.name}: ${reason(r.reason)}`] : []))
    setStatus(`${kind === 'pull' ? 'Pulled' : 'Fetched'} ${list.length - failed.length} of ${noun(list.length)}`)
    if (failed.length) setDialog({ kind: 'error', title: `${noun(failed.length)} could not be ${kind === 'pull' ? 'pulled' : 'fetched'}`, message: failed.join('\n\n') })
  }

  const drop = (id: number) => {
    const i = tabsRef.current.findIndex((t) => t.id === id)
    const rest = tabsRef.current.filter((t) => t.id !== id)
    tabsRef.current = rest
    setTabs(rest)
    setDirty((d) => (d.has(id) ? new Set([...d].filter((x) => x !== id)) : d))
    setSummaries(({ [id]: _, ...rest }) => rest)
    apis.current.delete(id)
    setActive((a) => (a === id ? rest[Math.min(i, rest.length - 1)]?.id : a))
  }

  const close = (id: number) => {
    const t = tabsRef.current.find((x) => x.id === id)
    if (t && dirty.has(id)) setDialog({ kind: 'confirm', message: `Unsaved edits in ${t.name} will be lost. Continue?`, action: () => drop(id) })
    else drop(id)
  }

  const markDirty = (id: number, d: boolean) =>
    setDirty((s) => {
      if (s.has(id) === d) return s
      const next = new Set(s)
      if (d) next.add(id)
      else next.delete(id)
      return next
    })

  const openInfo = (info: RepoInfo, focus = true) => add({ key: info.dir, name: info.name, title: info.dir, be: httpBackend(location.origin, token!, info.dir) }, focus)

  const openPath = async (path: string, focus = true, quiet = false) => {
    try {
      openInfo(await helper!.openRepo(path), focus)
      setRecentRepos((await helper!.repos()).recent)
    } catch (e) {
      if (!quiet) fail('Could not open the repository', e)
    }
  }

  const openMany = async (dirs: string[]) => {
    for (const d of dirs) await openPath(d, tabsRef.current.length === 0)
  }

  const browse = async () => {
    try {
      const path = await helper!.pickFolder()
      if (path) await openPath(path)
    } catch (e) {
      fail('Could not show a folder picker', e)
    }
  }

  const openHandle = async (handle: FileSystemDirectoryHandle) => {
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return
    const same = await Promise.all(handles.map((h) => h.isSameEntry(handle).catch(() => false)))
    const list = [handle, ...handles.filter((_, i) => !same[i])].slice(0, 10)
    setHandles(list)
    await set('recent', list)
    const open = await Promise.all(tabsRef.current.map((t) => t.handle?.isSameEntry(handle).catch(() => false)))
    const hit = tabsRef.current.find((_, i) => open[i])
    if (hit) return setActive(hit.id)
    add({ key: `fs:${nextId}`, name: handle.name, title: handle.name, handle, be: localBackend({ fs: new FsaFs(handle), dir: '/', cache: {}, fallbackAuthor }, loadSettings) })
  }

  const pickFolder = async () => {
    try {
      await openHandle(await window.showDirectoryPicker({ mode: 'readwrite' }))
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) fail('Could not open the folder', e)
    }
  }

  const openDemo = () =>
    demoRepo()
      .then((ctx) => add({ key: 'demo', name: 'demo', title: 'Demo repository', be: localBackend(ctx, loadSettings) }))
      .catch((e) => fail('Could not build the demo', e))

  useEffect(() => {
    if (helper)
      helper
        .repos()
        .then(async ({ current, recent }) => {
          setRecentRepos(recent)
          const [pins, prefs] = await Promise.all([helper!.pins(), helper!.prefs().catch(() => ({}) as Record<string, unknown>)])
          if (prefs.theme === 'dark' || prefs.theme === 'light') setTheme(prefs.theme)
          setScheme(isScheme(prefs.scheme) ? prefs.scheme : undefined)
          if (isMergeMethod(prefs.mergeMethod)) setMergeMethod(prefs.mergeMethod)
          for (const r of pins) pinnedKeys.current.add(r.dir)
          // the repositories open when Ramulus last closed come back in their order, with the pinned ones
          const saved = Array.isArray(prefs.open) ? prefs.open.filter((d): d is string => typeof d === 'string') : []
          const order = [...new Set([...(current && !saved.includes(current.dir) ? [current.dir] : []), ...saved, ...pins.map((r) => r.dir)])]
          try {
            for (const dir of order) {
              if (dir === current?.dir) openInfo(current)
              else await openPath(dir, false, true)
            }
          } finally {
            setPrefsReady(true)
          }
          const { root, inside, repos } = await helper!.findRepos()
          setFound(repos)
          const unopened = repos.filter((r) => !tabsRef.current.some((t) => t.key === r.dir))
          if (unopened.length) setDialog({ kind: 'repos', folder: root, inside, repos: unopened, open: openMany })
        })
        .catch((e) => fail('Could not reach the helper', e))
    else get<FileSystemDirectoryHandle[]>('recent').then((r) => r && setHandles(r))
  }, [])

  const choices: Command[] = helper
    ? [
        { id: 'browse', group: 'Open', label: 'Browse for a folder…', run: browse },
        ...found.filter((r) => !tabs.some((t) => t.key === r.dir)).map((r) => ({ id: `f:${r.dir}`, group: 'This folder', label: r.name, hint: r.dir, run: () => openPath(r.dir) })),
        ...recentRepos.filter((r) => !tabs.some((t) => t.key === r.dir)).map((r) => ({ id: r.dir, group: 'Recent', label: r.name, hint: r.dir, run: () => openPath(r.dir) }))]
    : [
        ...(canPick ? [{ id: 'pick', group: 'Open', label: 'Open a folder…', run: pickFolder }] : []),
        { id: 'demo', group: 'Open', label: 'Demo repository', run: openDemo },
        ...handles.map((h, i) => ({ id: `h${i}`, group: 'Recent', label: h.name, run: () => openHandle(h).catch((e) => fail('Could not open the folder', e)) })),
      ]
  const typedPath = (q: string): Command[] => (helper && looksLikePath.test(q.trim()) ? [{ id: 'path', group: 'Open', label: q.trim(), hint: 'Open this path', run: () => openPath(q.trim()) }] : [])
  const toggleTheme = () => {
    setScheme(undefined)
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }

  const recentList: SideRecent[] = helper
    ? [...found, ...recentRepos]
        .filter((r, i, all) => all.findIndex((x) => x.dir === r.dir) === i && !tabs.some((t) => t.key === r.dir))
        .map((r) => ({ key: r.dir, name: r.name, title: r.dir, open: () => openPath(r.dir) }))
    : handles.map((h, i) => ({ key: `h${i}`, name: h.name, title: h.name, open: () => openHandle(h).catch((e) => fail('Could not open the folder', e)) }))

  return (
    <div class={`shell ${docked ? 'with-sidebar' : ''}`} style={{ '--sb-w': `${sideW}px` }}>
      {!docked && <div class="sb-edge" onMouseEnter={reveal} />}
      <Sidebar
        tabs={tabs.map((t) => ({ id: t.id, name: t.name, title: t.title, pinned: t.pinned, dirty: dirty.has(t.id), summary: summaries[t.id] }))}
        active={active}
        recent={recentList}
        docked={docked}
        shown={docked || shown}
        focusSearch={searchTick}
        running={running}
        status={status}
        onActivate={(id) => {
          setActive(id)
          if (!docked) setShown(false)
        }}
        onClose={close}
        onPin={togglePin}
        onMove={move}
        onPeek={peekTerms}
        onPickTerm={pickTerm}
        onOpen={() => setPicker(true)}
        onDock={toggleDock}
        onMore={(r) =>
          setMenu({
            x: r.left,
            y: r.bottom + 4,
            items: [
              { label: 'Fetch every repository', onClick: () => void runAll('fetch') },
              { label: 'Pull every repository (fast-forward only)', onClick: () => void runAll('pull') },
            ],
          })
        }
        onEnter={reveal}
        onLeave={() => !docked && conceal()}
      />
      {docked && <Splitter onDrag={(dx) => setSideW((w) => Math.min(480, Math.max(170, w + dx)))} />}
      <div class="shell-main">
        {tabs.map((t) => (
          <div key={t.id} class="tab-page" hidden={t.id !== active}>
            <App
              be={t.be}
              name={t.name}
              active={t.id === active}
              theme={theme}
              onTheme={setTheme}
              scheme={scheme}
              onScheme={setScheme}
              onOpenRepo={() => setPicker(true)}
              onDirty={(d) => markDirty(t.id, d)}
              onApi={(api) => apis.current.set(t.id, api)}
              onSearchRepos={searchRepos}
              onAll={runAll}
              onSummary={(s) => setSummaries((m) => (sameSummary(m[t.id], s) ? m : { ...m, [t.id]: s }))}
              mergeMethod={mergeMethod}
              onMergeMethod={setMergeMethod}
            />
          </div>
        ))}
        {tabs.length === 0 && (
          <div class="app">
            <div class="toolbar">
              <div class="tb-side">
                <BrandMark />
                <span class="repo">Ramulus</span>
              </div>
              <div />
              <div class="tb-side tb-end">
                <BrandLinks />
              </div>
            </div>
            <div class="welcome">
              <h1>
                <BrandMark />
                Ramulus
              </h1>
              <p>Every branch of your repository, in one graph.{helper ? '' : ' Runs entirely in this browser tab.'}</p>
              <div style={{ display: 'flex', gap: '8px' }}>
                {helper ? (
                  <button class="primary" onClick={() => setPicker(true)}>
                    Open a folder…
                  </button>
                ) : (
                  <>
                    {canPick && (
                      <button class="primary" onClick={pickFolder}>
                        Open a repository folder
                      </button>
                    )}
                    <button class="secondary" onClick={openDemo}>
                      Try the demo repository
                    </button>
                  </>
                )}
              </div>
              {!helper && !canPick && <p class="note">Opening folders needs a Chromium browser. Safari and Firefox run the demo only.</p>}
              {(helper ? recentRepos.length : handles.length) > 0 && (
                <div class="recent">
                  <span class="label">Recent</span>
                  {helper
                    ? recentRepos.map((r) => (
                        <a key={r.dir} title={r.dir} onClick={() => openPath(r.dir)}>
                          {r.name}
                        </a>
                      ))
                    : handles.map((h, i) => (
                        <a key={i} onClick={() => openHandle(h).catch((e) => fail('Could not open the folder', e))}>
                          {h.name}
                        </a>
                      ))}
                </div>
              )}
              {!helper && (
                <>
                  <p class="note">Only avatar lookups and, when you use them, fetch, pull and push through your CORS proxy leave this machine.</p>
                  <p class="note">
                    For full speed and your SSH keys, run <code>npx ramulus</code>.
                  </p>
                </>
              )}
            </div>
            <div class="statusbar">
              <span class="spacer" />
              <button onClick={toggleTheme} title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}>
                <Icon name="color-mode" />
              </button>
            </div>
          </div>
        )}
      </div>
      {menu && <Menu menu={menu} onClose={() => setMenu(undefined)} />}
      {picker && <Palette commands={choices} extra={typedPath} placeholder={helper ? 'Type a path, or pick a recent project' : 'Pick a repository'} onClose={() => setPicker(false)} />}
      {dialog && (
        <Dialogs
          dialog={dialog}
          settings={loadSettings()}
          native={!!helper}
          onClose={() => setDialog(undefined)}
          onCreateBranch={() => {}}
          onCreateTag={() => {}}
          onRename={() => {}}
          onStash={() => {}}
          onReset={() => {}}
          onSettings={() => {}}
        />
      )}
    </div>
  )
}
