import { useEffect, useRef, useState } from 'preact/hooks'
import type { Backend, FileVersions, PrChange, PullRequest } from '../git/backend'
import { mixedEol } from '../git/chunk'
import type { FileChange, WorkStatus } from '../git/repo'
import { Icon, PR_ICON, short } from './bits'
import { PrView } from './PrView'
import { ReviewPane } from './Review'
import type { FileSel } from './DetailPanel'
import { DiffEditor, FileEditor, type ChunkAction, type DiffEditorHandle, type DiffMode } from './DiffEditor'

export interface DiffOptions {
  wrap: boolean
  mode: DiffMode
  collapse: boolean
}

export interface DiffTab {
  key: string
  sel: FileSel
  dirty: boolean
  file?: boolean
  pr?: PullRequest
  /** every change of sel.area in one scrolling list */
  review?: boolean
}

type PaneHandle = DiffEditorHandle & { save: () => void }

export const tabKey = (s: FileSel) => `${s.area.kind}:${s.area.kind === 'commit' ? s.area.oid : ''}:${s.path}`

function describe(sel: FileSel): string {
  return sel.area.kind === 'unstaged' ? 'Working Tree' : sel.area.kind === 'staged' ? 'Index' : short(sel.area.oid)
}

function DiffPane(p: {
  tab: DiffTab
  be: Backend
  stamp: unknown
  active: boolean
  options: DiffOptions
  look: string
  actions: ChunkAction[]
  onDirty: (dirty: boolean) => void
  onSave: (text: string, base: string, done: () => void) => void
  handle: (h: PaneHandle) => void
  onGone: () => void
}) {
  const [versions, setVersions] = useState<FileVersions>()
  const { sel, dirty } = p.tab
  const settled = sel.area.kind === 'commit' && !!versions
  useEffect(() => {
    if (dirty || !p.active || settled) return
    let live = true
    p.be
      .fileVersions(sel.area, sel.path)
      .then((v) => live && setVersions(v))
      .catch(() => live && setVersions({ old: '', new: '', binary: true }))
    return () => {
      live = false
    }
  }, [p.be, p.stamp, dirty, p.active])
  const ref = useRef<DiffEditorHandle | undefined>(undefined)
  const latest = useRef({ p, versions })
  latest.current = { p, versions }
  useEffect(() => () => latest.current.p.onGone(), [])
  const mixed = !!versions && (mixedEol(versions.old) || mixedEol(versions.new))
  const save = () => {
    const { p: cur, versions: v } = latest.current
    if (!ref.current || !v || sel.area.kind !== 'unstaged' || mixedEol(v.new)) return
    const text = ref.current.text()
    cur.onSave(text, v.new, () => {
      setVersions((x) => x && { ...x, new: text })
      latest.current.p.onDirty(ref.current?.text() !== text)
    })
  }
  return (
    <div class="diff-pane" hidden={!p.active}>
      {mixed && <div class="pane-note">This file mixes line ending styles, so editing and block staging are off here. Stage or discard the whole file from the list.</div>}
      {!versions ? (
        <div class="placeholder">Loading…</div>
      ) : versions.binary ? (
        <div class="placeholder">Binary or very large file</div>
      ) : p.tab.file ? (
        <FileEditor
          text={versions.new}
          filename={sel.path}
          look={p.look}
          wrap={p.options.wrap}
          editable={!mixed}
          onDirty={p.onDirty}
          onSave={save}
          handle={(h) => {
            ref.current = h
            p.handle({ ...h, save })
          }}
        />
      ) : (
        <DiffEditor
          oldText={versions.old}
          newText={versions.new}
          filename={sel.path}
          mode={p.options.mode}
          look={p.look}
          wrap={p.options.wrap}
          collapse={p.options.collapse}
          editable={sel.area.kind === 'unstaged' && !mixed}
          dirty={dirty}
          actions={mixed ? [] : p.actions}
          onDirty={p.onDirty}
          onSave={save}
          handle={(h) => {
            ref.current = h
            p.handle({ ...h, save })
          }}
        />
      )}
    </div>
  )
}

export function DiffWindow(p: {
  tabs: DiffTab[]
  active: string
  shown: boolean
  be: Backend
  stamp: unknown
  options: DiffOptions
  look: string
  actionsFor: (sel: FileSel) => ChunkAction[]
  onActivate: (key: string) => void
  onGraph: boolean
  onShowGraph: () => void
  onCloseTab: (key: string) => void
  onCloseAll: () => void
  onOptions: (o: DiffOptions) => void
  onDirty: (key: string, dirty: boolean) => void
  onSave: (sel: FileSel, text: string, base: string, done: () => void) => void
  onOpen?: (sel: FileSel) => void
  onMergePr?: (pr: PullRequest) => void
  onChangePr?: (pr: PullRequest, action: PrChange) => void
  status: WorkStatus
  onOpenFile: (sel: FileSel) => void
  onStage: (files: FileChange[]) => void
  onUnstage: (paths: string[]) => void
  busy: boolean
}) {
  const [max, setMax] = useState(false)
  const handles = useRef(new Map<string, PaneHandle>())
  const strip = useRef<HTMLDivElement>(null)
  const current = p.tabs.find((t) => t.key === p.active) ?? p.tabs[0]
  const h = () => handles.current.get(current.key)
  const live = (key: string) => !p.onGraph && key === current.key

  useEffect(() => {
    strip.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [current.key, p.onGraph])

  const toggle = (k: 'wrap' | 'collapse') => p.onOptions({ ...p.options, [k]: !p.options[k] })
  const parts = current.sel.path.split('/')

  return (
    <div class={`diff-window ${p.onGraph ? 'on-graph' : max ? 'max' : ''}`} role="region" aria-label="Diff">
      <div class="diff-tabs" onDblClick={(e) => !p.onGraph && !(e.target as Element).closest('button, .tab') && setMax(!max)}>
        <div
          class={`tab pinned ${p.onGraph ? 'active' : ''}`}
          title="The commit graph"
          role="tab"
          tabIndex={0}
          aria-selected={p.onGraph}
          onClick={p.onShowGraph}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            p.onShowGraph()
          }}
        >
          <Icon name="git-commit" />
          <span class="name">Graph</span>
        </div>
        <div class="tab-strip" ref={strip}>
          {p.tabs.map((t) => {
            const name = t.pr ? `#${t.pr.number}` : t.review ? 'Review' : t.sel.path.slice(t.sel.path.lastIndexOf('/') + 1)
            return (
              <div
                key={t.key}
                class={`tab ${live(t.key) ? 'active' : ''} ${t.dirty ? 'dirty' : ''}`}
                title={t.pr ? t.pr.title : t.file ? t.sel.path : t.review ? `Every change (${describe(t.sel)})` : `${t.sel.path} (${describe(t.sel)})`}
                role="tab"
                tabIndex={0}
                aria-selected={live(t.key)}
                onClick={() => p.onActivate(t.key)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  p.onActivate(t.key)
                }}
                onMouseDown={(e) => {
                  if (e.button !== 1) return
                  e.preventDefault()
                  p.onCloseTab(t.key)
                }}
              >
                <Icon name={t.pr ? PR_ICON[t.pr.state] : t.file ? 'file' : t.review ? 'diff-multiple' : 'diff'} />
                <span class="name">{name}</span>
                {t.pr ? <span class="desc">{t.pr.title}</span> : !t.file && <span class="desc">({describe(t.sel)})</span>}
                <button
                  class="icon close"
                  title={t.dirty ? 'Unsaved edits. Close' : 'Close'}
                  onClick={(e) => {
                    e.stopPropagation()
                    p.onCloseTab(t.key)
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
          })}
        </div>
        <div class="actions">
          {current.dirty && (
            <button class="icon" title="Save (⌘S)" onClick={() => h()?.save()}>
              <Icon name="save" />
            </button>
          )}
          {p.onOpen && current.sel.area.kind !== 'commit' && !current.pr && !current.review && (
            <button class="icon" title="Open File" onClick={() => p.onOpen!(current.sel)}>
              <Icon name="go-to-file" />
            </button>
          )}
          {!current.file && !current.pr && !current.review && (
            <>
              <button class="icon" title="Previous Change" onClick={() => h()?.prev()}>
                <Icon name="arrow-up" />
              </button>
              <button class="icon" title="Next Change" onClick={() => h()?.next()}>
                <Icon name="arrow-down" />
              </button>
              <button class={`icon ${p.options.collapse ? 'on' : ''}`} title="Collapse Unchanged Regions" onClick={() => toggle('collapse')}>
                <Icon name="fold" />
              </button>
            </>
          )}
          {!current.file && !current.pr && (
            <>
              <button class={`icon ${p.options.mode === 'inline' ? 'on' : ''}`} title="Toggle Inline View" onClick={() => p.onOptions({ ...p.options, mode: p.options.mode === 'split' ? 'inline' : 'split' })}>
                <Icon name="diff-single" />
              </button>
            </>
          )}
          {!current.pr && (
            <button class={`icon ${p.options.wrap ? 'on' : ''}`} title="Toggle Word Wrap" onClick={() => toggle('wrap')}>
              <Icon name="word-wrap" />
            </button>
          )}
          <span class="sep" />
          <button class="icon" title={max ? 'Restore' : 'Maximize'} onClick={() => setMax(!max)}>
            <Icon name={max ? 'screen-normal' : 'screen-full'} />
          </button>
          <button class="icon" title="Close all" onClick={p.onCloseAll}>
            <Icon name="close" />
          </button>
        </div>
      </div>
      {!current.pr && !current.review && (
        <div class="breadcrumbs">
          {parts.map((s, i) => (
            <span key={i} class="crumb">
              {i > 0 && <Icon name="chevron-right" />}
              {i === parts.length - 1 && <Icon name="file" />}
              {s}
            </span>
          ))}
        </div>
      )}
      {p.tabs.map((t) =>
        t.pr ? (
          <div key={t.key} class="diff-pane" hidden={!live(t.key)}>
            <PrView be={p.be} pr={t.pr} active={p.shown && live(t.key)} stamp={p.stamp} busy={p.busy} onMerge={p.onMergePr} onChange={p.onChangePr} />
          </div>
        ) : t.review ? (
          <div key={t.key} class="diff-pane" hidden={!live(t.key)}>
            <ReviewPane
              be={p.be}
              stamp={p.stamp}
              active={p.shown && live(t.key)}
              area={t.sel.area}
              status={p.status}
              mode={p.options.mode}
              look={p.look}
              wrap={p.options.wrap}
              actionsFor={p.actionsFor}
              onOpenFile={p.onOpenFile}
              onStage={p.onStage}
              onUnstage={p.onUnstage}
            />
          </div>
        ) : (
        <DiffPane
          key={t.key}
          tab={t}
          be={p.be}
          stamp={p.stamp}
          active={live(t.key)}
          options={p.options}
          look={p.look}
          actions={p.actionsFor(t.sel)}
          onDirty={(d) => p.onDirty(t.key, d)}
          onSave={(text, base, done) => p.onSave(t.sel, text, base, done)}
          handle={(x) => handles.current.set(t.key, x)}
          onGone={() => handles.current.delete(t.key)}
        />
        ),
      )}
    </div>
  )
}
