import { useEffect, useRef, useState } from 'preact/hooks'
import type { Backend, FileVersions } from '../git/backend'
import { mixedEol } from '../git/chunk'
import type { DiffArea, FileChange, WorkStatus } from '../git/repo'
import { Icon } from './bits'
import { kindColor, type FileSel } from './DetailPanel'
import { DiffEditor, type ChunkAction, type DiffMode } from './DiffEditor'

// shortcut: shows the first 100 files, each one an editor; page them if agents start changing more at once
const MAX = 100
const LINE_H = 19

interface Shared {
  be: Backend
  stamp: unknown
  active: boolean
  mode: DiffMode
  look: string
  wrap: boolean
  actionsFor: (sel: FileSel) => ChunkAction[]
  onOpenFile: (sel: FileSel) => void
  onStage: (files: FileChange[]) => void
  onUnstage: (paths: string[]) => void
}

function ReviewFile(p: Shared & { area: DiffArea; f: FileChange }) {
  const box = useRef<HTMLElement>(null)
  const [near, setNear] = useState(false)
  const [versions, setVersions] = useState<FileVersions>()
  // the height it had when it scrolled away, kept so the list does not jump
  const [away, setAway] = useState<number>()
  const sel: FileSel = { area: p.area, path: p.f.path }

  // Only the files close to the view have an editor and follow changes, so a long list stays light.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const io = new IntersectionObserver(
      (es) => {
        const on = es[es.length - 1].isIntersecting
        if (!on) setAway(el.offsetHeight)
        setNear(on)
      },
      { rootMargin: '800px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!near || !p.active || (p.area.kind === 'commit' && versions)) return
    let live = true
    p.be
      .fileVersions(p.area, p.f.path)
      .then((v) => live && setVersions(v))
      .catch(() => live && setVersions({ old: '', new: '', binary: true }))
    return () => {
      live = false
    }
  }, [near, p.active, p.stamp])

  const mixed = !!versions && (mixedEol(versions.old) || mixedEol(versions.new))
  const guess = Math.min(600, ((p.f.added ?? 4) + (p.f.deleted ?? 4) + 6) * LINE_H)
  const kind = p.f.conflict ? '!' : p.f.kind === '?' ? 'U' : p.f.kind
  return (
    <section class="rv-file" ref={box} style={!near && away ? { minHeight: `${away}px` } : undefined}>
      <header class="rv-head">
        <span class="k" style={{ color: p.f.conflict ? 'var(--git-conflict)' : kindColor(p.f.kind) }}>{kind}</span>
        <button class="rv-path" title="Open it in its own tab" onClick={() => p.onOpenFile(sel)}>
          {p.f.path}
        </button>
        <span class="stats">
          {p.f.added ? <span class="plus">+{p.f.added}</span> : null}
          {p.f.deleted ? <span class="minus">−{p.f.deleted}</span> : null}
        </span>
        <span class="spacer" />
        {p.area.kind === 'unstaged' && (
          <button class="icon" title="Stage the whole file" aria-label={`Stage ${p.f.path}`} onClick={() => p.onStage([p.f])}>
            <Icon name="add" />
          </button>
        )}
        {p.area.kind === 'staged' && (
          <button class="icon" title="Unstage the whole file" aria-label={`Unstage ${p.f.path}`} onClick={() => p.onUnstage([p.f.path])}>
            <Icon name="remove" />
          </button>
        )}
      </header>
      {!near ? (
        !away && <div class="rv-wait" style={{ height: `${guess}px` }} />
      ) : !versions ? (
        <div class="rv-wait" style={{ height: `${guess}px` }} />
      ) : versions.binary ? (
        <div class="rv-note">Binary or very large file</div>
      ) : (
        <DiffEditor
          oldText={versions.old}
          newText={versions.new}
          filename={p.f.path}
          mode={p.mode}
          look={p.look}
          wrap={p.wrap}
          collapse
          editable={false}
          dirty={false}
          actions={mixed ? [] : p.actionsFor(sel)}
          onDirty={() => {}}
          onSave={() => {}}
          fit
        />
      )}
    </section>
  )
}

/** Every change of the working tree, the index or a commit, one diff after another. */
export function ReviewPane(p: Shared & { area: DiffArea; status: WorkStatus }) {
  const [commitFiles, setCommitFiles] = useState<FileChange[]>()
  const oid = p.area.kind === 'commit' ? p.area.oid : undefined
  useEffect(() => {
    if (!oid) return
    let live = true
    p.be.commitFiles(oid).then(
      (f) => live && setCommitFiles(f),
      () => live && setCommitFiles([]),
    )
    return () => {
      live = false
    }
  }, [oid])
  const files = oid ? commitFiles : p.area.kind === 'staged' ? p.status.staged : p.status.unstaged
  if (!files) return <div class="placeholder">Loading…</div>
  if (!files.length) return <div class="placeholder">{oid ? 'This commit changes no files' : 'Nothing left to review here'}</div>
  return (
    <div class="review">
      {files.slice(0, MAX).map((f) => (
        <ReviewFile key={f.path} {...p} f={f} />
      ))}
      {files.length > MAX && (
        <div class="rv-note">
          Showing the first {MAX} of {files.length} files. Open the others from the list.
        </div>
      )}
    </div>
  )
}
