import type { JSX } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { CiRun } from '../git/backend'
import type { RowLayout } from '../git/graph'
import type { BranchInfo, Commit, RefLabel } from '../git/repo'
import { ago, Avatar, CI_ICON, CI_WORD, ciState, fmtDate, Icon, laneColor, Laptop, short, type wipTally } from './bits'

export const ROW_H = 30
const COL_W = 24
const GUTTER = 22
const NODE_R = 11
const MERGE_R = 5.5

export interface PillData {
  key: string
  name: string
  local?: RefLabel
  remote?: RefLabel
  tag?: RefLabel
  current: boolean
  ahead?: number
  behind?: number
}

export interface DropInfo {
  source: PillData
  rowIndex: number
  x: number
  y: number
}

export interface GraphProps {
  rows: Commit[]
  layoutOf: (index: number) => RowLayout
  maxCol: number
  refsByOid: Map<string, RefLabel[]>
  branches: BranchInfo[]
  order: number[]
  showEdges: boolean
  selectedIndex: number
  scrollTo?: number
  wip: ReturnType<typeof wipTally>
  hasMore: boolean
  soloCount: number
  onSelect: (index: number) => void
  onContextMenu: (e: MouseEvent, index: number) => void
  /** GitHub Actions runs by commit */
  ci: Map<string, CiRun[]>
  onCi: (e: MouseEvent, runs: CiRun[]) => void
  onPillDoubleClick: (pill: PillData) => void
  onDrop: (info: DropInfo) => void
  onLoadMore: () => void
  onScrolled: () => void
  onClearSolo: () => void
}

function laneX(col: number): number {
  return 3 + GUTTER + col * COL_W + COL_W / 2
}

export function groupPills(refs: RefLabel[], branches: BranchInfo[]): PillData[] {
  const byName = new Map<string, PillData>()
  const get = (key: string, name: string) => {
    let p = byName.get(key)
    if (!p) {
      p = { key, name, current: false }
      byName.set(key, p)
    }
    return p
  }
  for (const l of refs) {
    if (l.kind === 'head') {
      const p = get(`b:${l.name}`, l.name)
      p.local = l
      p.current = !!l.current
      const b = branches.find((x) => x.name === l.name)
      if (b?.upstream) {
        p.ahead = b.ahead
        p.behind = b.behind
      }
    } else if (l.kind === 'remote') {
      const bare = l.name.slice(l.name.indexOf('/') + 1)
      const localHere = refs.some((r) => r.kind === 'head' && r.name === bare && branches.find((x) => x.name === bare)?.upstream === l.name)
      const p = localHere ? get(`b:${bare}`, bare) : get(`r:${l.name}`, l.name)
      p.remote = l
    } else {
      const p = get(`t:${l.name}`, l.name)
      p.tag = l
    }
  }
  return [...byName.values()].sort((a, b) => rank(a) - rank(b))
}

function rank(p: PillData): number {
  if (p.current) return 0
  if (p.local) return 1
  if (p.remote) return 2
  return 3
}

function Lanes({ lay, kind, author, email, drawEdges }: { lay: RowLayout; kind: Commit['kind']; author: string; email: string; drawEdges: boolean }) {
  const w = 3 + GUTTER + (Math.max(...lay.edges.keys(), lay.column) + 1) * COL_W + 6
  const mid = ROW_H / 2
  const nx = laneX(lay.column)
  const color = laneColor(lay.column)
  const shapes: JSX.Element[] = []
  if (drawEdges) {
    for (const [col, e] of lay.edges) {
      const x = laneX(col)
      const c = laneColor(col)
      const dash = (k: Commit['kind']) => (k === 'wip' ? '4 3' : undefined)
      if (e.pass) shapes.push(<line x1={x} y1={0} x2={x} y2={ROW_H} stroke={c} stroke-width={2} stroke-dasharray={dash(e.pass.kind)} />)
      if (e.ending) {
        if (col === lay.column) shapes.push(<line x1={x} y1={0} x2={x} y2={mid} stroke={c} stroke-width={2} stroke-dasharray={dash(e.ending.kind)} />)
        else shapes.push(<path d={`M${x} 0 C${x} ${mid} ${x} ${mid} ${nx} ${mid}`} fill="none" stroke={c} stroke-width={2} />)
      }
      if (e.starting) {
        if (col === lay.column) shapes.push(<line x1={x} y1={mid} x2={x} y2={ROW_H} stroke={c} stroke-width={2} />)
        else shapes.push(<path d={`M${nx} ${mid} C${x} ${mid} ${x} ${mid} ${x} ${ROW_H}`} fill="none" stroke={c} stroke-width={2} />)
      }
    }
  } else {
    shapes.push(<line x1={nx} y1={0} x2={nx} y2={ROW_H} stroke={color} stroke-width={2} opacity={0.3} />)
  }
  let node: JSX.Element
  if (kind === 'merge') node = <circle cx={nx} cy={mid} r={MERGE_R} fill={color} />
  else if (kind === 'stash')
    node = (
      <g>
        <rect x={nx - 8} y={mid - 8} width={16} height={16} rx={3} fill="var(--app-bg)" stroke={color} stroke-width={2} />
        <text x={nx} y={mid + 4} text-anchor="middle" font-size={12} fill={color}>
          ≡
        </text>
      </g>
    )
  else if (kind === 'wip') node = <circle cx={nx} cy={mid} r={NODE_R} fill="var(--app-bg)" stroke={color} stroke-width={2} stroke-dasharray="3 2.5" />
  else node = <circle cx={nx} cy={mid} r={NODE_R} fill="var(--app-bg)" stroke={color} stroke-width={2} />
  return (
    <div class="lanes" style={{ position: 'relative' }}>
      <svg width={w} height={ROW_H}>
        {shapes}
        {node}
      </svg>
      {kind === 'commit' && (
        <span style={{ position: 'absolute', left: `${nx - 9}px`, top: `${mid - 9}px`, display: 'flex' }}>
          <Avatar name={author} email={email} color={color} size={18} />
        </span>
      )}
    </div>
  )
}

export function Pill({ pill, color, lifted, onDoubleClick, onPointerDown }: { pill: PillData; color: string; lifted?: boolean; onDoubleClick?: () => void; onPointerDown?: (e: PointerEvent) => void }) {
  const bg = pill.current ? `color-mix(in srgb, ${color} 55%, var(--bg))` : `color-mix(in srgb, ${color} 25%, transparent)`
  const parts: string[] = []
  if (pill.local) parts.push(pill.current ? 'Checked out' : 'Local branch. Double-click to switch, drag onto a commit to merge or rebase.')
  if (pill.remote) parts.push(`Remote: ${pill.remote.name}`)
  if (pill.tag) parts.push('Tag')
  if (pill.ahead || pill.behind) parts.push(`${pill.ahead ?? 0} ahead, ${pill.behind ?? 0} behind its upstream`)
  const draggable = !!(pill.local || pill.remote)
  return (
    <span
      class={`pill ${pill.current ? 'current' : ''} ${lifted ? 'lifted' : ''}`}
      style={{ background: bg, color: pill.current ? 'var(--fg-bright)' : color, boxShadow: pill.current ? `inset 0 0 0 1px ${color}` : undefined }}
      title={`${pill.name}\n${parts.join('\n')}`}
      onDblClick={onDoubleClick}
      data-draggable={draggable ? '1' : undefined}
      onPointerDown={(e) => draggable && e.button === 0 && onPointerDown?.(e)}
    >
      {pill.local && (pill.current ? <Icon name="check" /> : <Laptop />)}
      {pill.remote && <Icon name="cloud" />}
      {pill.tag && <Icon name="tag" />}
      {pill.name}
      {!!(pill.ahead || pill.behind) && (
        <span class="track">
          {pill.ahead ? <><Icon name="arrow-small-up" />{pill.ahead}</> : null}
          {pill.behind ? <><Icon name="arrow-small-down" />{pill.behind}</> : null}
        </span>
      )}
    </span>
  )
}

export function GraphView(p: GraphProps) {
  const box = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const [width, setWidth] = useState(1000)
  const [dropRow, setDropRow] = useState<number>()
  const dragging = useRef<PillData | undefined>(undefined)
  const [drag, setDrag] = useState<{ pill: PillData; idx: number; color: string; hint: string; ok: boolean }>()
  const ghost = useRef<HTMLDivElement>(null)
  const ghostAt = useRef('')
  const startDrag = (pill: PillData, from: number, color: string, e: PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const ox = e.clientX - rect.left
    const oy = e.clientY - rect.top
    const sx = e.clientX
    const sy = e.clientY
    let active = false
    let over: number | undefined
    let shown = ''
    let last = { x: sx, y: sy }
    let raf = 0
    const place = () => {
      ghostAt.current = `translate(${last.x - ox}px, ${last.y - oy}px)`
      if (ghost.current) ghost.current.style.transform = ghostAt.current
    }
    const aim = () => {
      const row = document.elementFromPoint(last.x, last.y)?.closest<HTMLElement>('.row[data-idx]')
      const idx = row ? Number(row.dataset.idx) : undefined
      const c = idx === undefined ? undefined : p.rows[idx]
      const src = pill.local?.name ?? pill.remote?.name ?? pill.name
      const targetHead = c && (p.refsByOid.get(c.id) ?? []).find((l) => l.kind === 'head' && l.current)
      let hint = 'Drop it on a commit'
      let next: number | undefined
      if (idx === from) hint = 'It is already here'
      else if (c && c.kind !== 'wip') {
        if (targetHead && targetHead.name !== src) hint = `Merge ${src} into ${targetHead.name}`
        else if (pill.current) hint = `Rebase or reset ${src} onto ${short(c.id)}`
        else hint = 'Switch to it first, or drop it on the checked-out branch'
        next = targetHead && targetHead.name !== src ? idx : pill.current ? idx : undefined
      }
      if (`${next}:${hint}` === shown) return
      shown = `${next}:${hint}`
      over = next
      setDropRow(over)
      setDrag({ pill, idx: from, color, hint, ok: over !== undefined })
      document.body.style.cursor = over !== undefined ? 'grabbing' : 'no-drop'
    }
    const scroll = () => {
      const el = box.current
      if (el) {
        const r = el.getBoundingClientRect()
        const dir = last.y < r.top + 36 ? -1 : last.y > r.bottom - 36 ? 1 : 0
        if (dir) {
          el.scrollTop += dir * 14
          aim()
        }
      }
      raf = requestAnimationFrame(scroll)
    }
    const move = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY }
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
      if (!active) {
        active = true
        document.body.classList.add('dragging')
        dragging.current = pill
        place()
        raf = requestAnimationFrame(scroll)
      }
      place()
      aim()
    }
    const finish = (drop: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      cancelAnimationFrame(raf)
      document.body.style.cursor = ''
      document.body.classList.remove('dragging')
      setDropRow(undefined)
      setDrag(undefined)
      if (drop && active && over !== undefined) p.onDrop({ source: pill, rowIndex: over, x: last.x, y: last.y })
      setTimeout(() => (dragging.current = undefined))
    }
    const up = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY }
      finish(true)
    }
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !active) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    const cancel = () => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
  }
  useLayoutEffect(() => {
    if (ghost.current) ghost.current.style.transform = ghostAt.current
  }, [drag])
  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      setHeight(el.clientHeight)
      setWidth(el.clientWidth)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (p.scrollTo === undefined || !box.current) return
    const pos = p.order.indexOf(p.scrollTo)
    if (pos >= 0) box.current.scrollTop = Math.max(0, pos * ROW_H - height / 2 + ROW_H / 2)
    p.onScrolled()
  }, [p.scrollTo])
  const count = p.order.length + (p.hasMore && p.showEdges ? 1 : 0)
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5)
  const end = Math.min(count, Math.ceil((scrollTop + height) / ROW_H) + 5)
  const graphW = Math.min(420, Math.max(56, 3 + GUTTER + (p.maxCol + 1) * COL_W + 6))
  const showWhen = width >= 660
  const showSha = width >= 820
  const refsW = Math.round(Math.min(240, Math.max(110, width * 0.18)))
  const cols = [`${refsW}px`, `${graphW}px`, 'minmax(0, 1fr)', ...(showWhen ? ['56px'] : []), ...(showSha ? ['72px'] : [])].join(' ')
  const items: JSX.Element[] = []
  for (let i = start; i < end; i++) {
    const top = i * ROW_H
    if (i >= p.order.length) {
      items.push(
        <div class="more" style={{ top: `${top}px` }} key="more">
          Showing {p.rows.length} commits.<a onClick={p.onLoadMore}>Load more</a>
        </div>,
      )
      continue
    }
    const idx = p.order[i]
    const c = p.rows[idx]
    const lay = p.layoutOf(idx)
    const color = laneColor(lay.column)
    const pills = c.kind === 'wip' ? [] : groupPills(p.refsByOid.get(c.id) ?? [], p.branches)
    const runs = c.kind === 'wip' ? undefined : p.ci.get(c.id)
    const ci = ciState(runs)
    items.push(
      <div
        key={c.id}
        class={`row ${idx === p.selectedIndex ? 'selected' : ''} ${dropRow === idx ? 'drop' : ''} ${pills.some((x) => x.current) ? 'head' : ''}`}
        style={{ top: `${top}px`, '--cols': cols }}
        data-idx={idx}
        onClick={() => !dragging.current && p.onSelect(idx)}
        onContextMenu={(e) => {
          e.preventDefault()
          p.onContextMenu(e, idx)
        }}
        title={c.body ? `${c.summary}\n\n${c.body}` : undefined}
      >
        <div class="refs">
          {pills.map((pill) => (
            <Pill
              key={pill.key}
              pill={pill}
              color={color}
              lifted={drag?.idx === idx && drag.pill.key === pill.key}
              onDoubleClick={() => p.onPillDoubleClick(pill)}
              onPointerDown={(e) => startDrag(pill, idx, color, e)}
            />
          ))}
        </div>
        <Lanes lay={lay} kind={c.kind} author={c.author} email={c.email} drawEdges={p.showEdges} />
        <div class={`msg ${c.kind}`} title={c.kind === 'wip' ? undefined : `${c.summary}\n${c.author} · ${fmtDate(c.time)} · ${short(c.id)}`}>
          {ci && runs && (
            <button
              class={`ci-mark ${ci}`}
              title={runs.map((r) => `${r.workflow}: ${CI_WORD[r.state]}`).join('\n')}
              aria-label={`GitHub checks ${CI_WORD[ci]}`}
              onClick={(e) => {
                e.stopPropagation()
                p.onCi(e, runs)
              }}
            >
              <Icon name={CI_ICON[ci]} />
            </button>
          )}
          {c.kind === 'wip' ? (
            <>
              <span class="wip-label">{'// WIP'}</span>
              {(
                [
                  ['M', 'edit', 'modified'],
                  ['A', 'add', 'added'],
                  ['D', 'remove', 'deleted'],
                ] as const
              ).map(([k, icon, word]) =>
                p.wip[k] > 0 && (
                  <span class={`wip-count ${k}`} role="img" aria-label={`${p.wip[k]} ${word}`} title={`${p.wip[k]} ${word}`}>
                    <Icon name={icon} />
                    {p.wip[k]}
                  </span>
                ),
              )}
            </>
          ) : (
            c.summary
          )}
        </div>
        {showWhen && (
          <div class="date" title={c.kind !== 'wip' ? fmtDate(c.time) : undefined}>
            {c.kind !== 'wip' && ago(c.time, true)}
          </div>
        )}
        {showSha && <div class="sha">{c.kind !== 'wip' && short(c.id)}</div>}
      </div>,
    )
  }
  return (
    <div class="graph">
      <div class="graph-header" style={{ '--cols': cols }}>
        <div>REFS</div>
        <div>GRAPH</div>
        <div>
          MESSAGE
          {p.soloCount > 0 && (
            <span class="chip" onClick={p.onClearSolo} title="Show every branch again">
              Soloing {p.soloCount} branch{p.soloCount === 1 ? '' : 'es'} · show all
            </span>
          )}
        </div>
        {showWhen && <div>WHEN</div>}
        {showSha && <div>SHA</div>}
      </div>
      <div class="rows" ref={box} onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}>
        <div style={{ height: `${count * ROW_H}px`, position: 'relative' }}>{items}</div>
        {p.rows.length === 0 && <div class="placeholder">No commits yet</div>}
      </div>
      {drag && (
        <div class="drag-ghost" ref={ghost} aria-hidden="true">
          <span class="ghost-pill">
            <Pill pill={drag.pill} color={drag.color} />
          </span>
          <span class={`drag-hint ${drag.ok ? 'ok' : ''}`}>{drag.hint}</span>
        </div>
      )}
    </div>
  )
}
