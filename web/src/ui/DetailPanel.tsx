import type { JSX } from 'preact'
import { useMemo, useState } from 'preact/hooks'
import type { Commit, DiffArea, FileChange, RepoData } from '../git/repo'
import { Avatar, Icon, ago, fmtDate, short } from './bits'

export interface FileSel {
  area: DiffArea
  path: string
}

export interface DetailProps {
  top?: JSX.Element
  data: RepoData
  commit?: Commit
  commitColor: string
  commitFiles: FileChange[]
  isStash: boolean
  selectedFile?: FileSel
  tree: boolean
  summary: string
  description: string
  amend: boolean
  onTree: (tree: boolean) => void
  onSummary: (s: string) => void
  onDescription: (s: string) => void
  onAmend: (b: boolean) => void
  onSelectFile: (f: FileSel) => void
  onStage: (files: FileChange[]) => void
  onUnstage: (paths: string[]) => void
  onDiscard: (files: FileChange[]) => void
  onStageAll: () => void
  onUnstageAll: () => void
  onCommit: () => void
  onCopy: (s: string) => void
  onJump: (oid: string) => void
  onFileMenu: (e: MouseEvent, f: FileChange, area: DiffArea) => void
  onAbort?: () => void
  onDropAutostash?: () => void
  onContinue?: () => void
  onAiCommit?: () => void
  aiDrafting?: boolean
  onAiFix?: (path: string) => void
}

export function kindColor(k: FileChange['kind']): string {
  return k === 'A' ? 'var(--git-added)' : k === '?' ? 'var(--git-untracked)' : k === 'D' ? 'var(--git-deleted)' : 'var(--git-modified)'
}

function Stats({ f }: { f: FileChange }) {
  if (f.added === undefined && f.deleted === undefined) return null
  return (
    <span class="stats">
      {f.added ? <span class="plus">+{f.added}</span> : null}
      {f.deleted ? <span class="minus">−{f.deleted}</span> : null}
    </span>
  )
}

function FileRow({ f, label, depth, selected, onClick, actions, onMenu }: { f: FileChange; label: string; depth: number; selected: boolean; onClick: () => void; actions?: JSX.Element; onMenu: (e: MouseEvent) => void }) {
  const i = f.path.lastIndexOf('/')
  const dir = depth > 0 || i < 0 ? '' : f.path.slice(0, i + 1)
  return (
    <div
      class={`file ${selected ? 'selected' : ''}`}
      style={{ paddingLeft: `${10 + depth * 14}px` }}
      onClick={onClick}
      title={f.path}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e)
      }}
    >
      <span class="n" style={{ color: f.conflict ? 'var(--git-conflict)' : kindColor(f.kind) }}>
        {label}
      </span>
      {dir ? <span class="d">{dir}</span> : <span class="spacer" />}
      {actions && <span class="acts">{actions}</span>}
      <Stats f={f} />
      <span class="k" style={{ color: f.conflict ? 'var(--git-conflict)' : kindColor(f.kind) }} title={f.conflict ? 'Conflicted' : f.kind === '?' ? 'Untracked' : f.kind === 'A' ? 'Added' : f.kind === 'D' ? 'Deleted' : 'Modified'}>
        {f.conflict ? '!' : f.kind === '?' ? 'U' : f.kind}
      </span>
    </div>
  )
}

export interface TreeNode<T = FileChange> {
  name: string
  path: string
  children: Map<string, TreeNode<T>>
  file?: T
}

export function buildTree<T extends { path: string }>(files: T[]): TreeNode<T> {
  const root: TreeNode<T> = { name: '', path: '', children: new Map() }
  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/')
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, path, children: new Map() }
        node.children.set(part, child)
      }
      node = child
    })
    node.file = f
  }
  const collapse = (n: TreeNode<T>): TreeNode<T> => {
    for (const [k, c] of n.children) n.children.set(k, collapse(c))
    if (!n.file && n.children.size === 1 && n.path) {
      const only = [...n.children.values()][0]
      if (!only.file) return { ...only, name: `${n.name}/${only.name}` }
    }
    return n
  }
  return collapse(root)
}

function FileList(p: { files: FileChange[]; tree: boolean; isSelected: (f: FileChange) => boolean; onPick: (f: FileChange) => void; actions?: (f: FileChange) => JSX.Element; onMenu: (e: MouseEvent, f: FileChange) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const root = useMemo(() => (p.tree ? buildTree(p.files) : undefined), [p.files, p.tree])
  if (!p.tree) {
    return (
      <>
        {p.files.map((f) => (
          <FileRow key={f.path} f={f} label={f.path.slice(f.path.lastIndexOf('/') + 1)} depth={0} selected={p.isSelected(f)} onClick={() => p.onPick(f)} actions={p.actions?.(f)} onMenu={(e) => p.onMenu(e, f)} />
        ))}
      </>
    )
  }
  const render = (n: TreeNode, depth: number): JSX.Element[] => {
    const out: JSX.Element[] = []
    const dirs = [...n.children.values()].filter((c) => !c.file).sort((a, b) => a.name.localeCompare(b.name))
    const files = [...n.children.values()].filter((c) => c.file).sort((a, b) => a.name.localeCompare(b.name))
    for (const d of dirs) {
      const isClosed = closed.has(d.path)
      out.push(
        <div key={d.path} class="file dir" style={{ paddingLeft: `${10 + depth * 14}px` }} onClick={() => setClosed((s) => {
          const next = new Set(s)
          if (next.has(d.path)) next.delete(d.path)
          else next.add(d.path)
          return next
        })}>
          <Icon name={isClosed ? 'chevron-right' : 'chevron-down'} />
          <span class="n">{d.name}</span>
        </div>,
      )
      if (!isClosed) out.push(...render(d, depth + 1))
    }
    for (const f of files) {
      out.push(<FileRow key={f.path} f={f.file!} label={f.name} depth={depth} selected={p.isSelected(f.file!)} onClick={() => p.onPick(f.file!)} actions={p.actions?.(f.file!)} onMenu={(e) => p.onMenu(e, f.file!)} />)
    }
    return out
  }
  return <>{render(root!, 0)}</>
}


export function DetailPanel(p: DetailProps) {
  const treeToggle = (
    <button class="icon" title={p.tree ? 'Show as a flat list' : 'Show as a tree'} onClick={() => p.onTree(!p.tree)}>
      <Icon name={p.tree ? 'list-flat' : 'list-tree'} />
    </button>
  )
  if (p.commit) {
    const c = p.commit
    return (
      <div class="detail">
        {p.top}
        <div class="detail-head">
          <h2>{c.summary}</h2>
          <div class="who">
            <Avatar name={c.author} email={c.email} color={p.commitColor} size={26} />
            <div>
              <div title={c.email}>{c.author}</div>
              <div class="when">
                {fmtDate(c.time)} · {ago(c.time)}
              </div>
            </div>
          </div>
          <div class="hashes">
            <button title="Copy full hash" onClick={() => p.onCopy(c.id)}>
              {short(c.id)}
            </button>
            {c.parents.map((pid) => (
              <button class="ghost" key={pid} onClick={() => p.onJump(pid)}>
                parent {short(pid)}
              </button>
            ))}
          </div>
          {c.body && <div class="body">{c.body}</div>}
        </div>
        <div class="hr" />
        <div class="fhead">
          {p.isStash ? 'Stash' : 'Changes'}
          <span class="count">{p.commitFiles.length}</span>
          <span class="spacer" />
          {treeToggle}
        </div>
        <div class="files">
          <FileList files={p.commitFiles} tree={p.tree} isSelected={(f) => p.selectedFile?.area.kind === 'commit' && p.selectedFile.area.oid === c.id && p.selectedFile.path === f.path} onPick={(f) => p.onSelectFile({ area: { kind: 'commit', oid: c.id }, path: f.path })} onMenu={(e, f) => p.onFileMenu(e, f, { kind: 'commit', oid: c.id })} />
        </div>
      </div>
    )
  }
  const s = p.data.status
  const canCommit = (s.staged.length > 0 || p.amend) && p.summary.trim().length > 0
  const label = p.amend ? 'Amend' : s.staged.length ? `Commit ${s.staged.length} file${s.staged.length === 1 ? '' : 's'}` : 'Commit'
  const why = !s.staged.length && !p.amend ? 'Stage a change first' : !p.summary.trim() ? 'Write a summary first' : '⌘⏎'
  const isSel = (area: DiffArea['kind'], path: string) => p.selectedFile?.area.kind === area && p.selectedFile.path === path
  const state = s.state
  const conflicts = s.unstaged.filter((f) => f.conflict).length
  const autostash = !state && p.onDropAutostash && p.data.stashes.some((x) => /autostash$/.test(x.message))
  return (
    <div class="detail">
      {p.top}
      {autostash && (
        <div class="banner">
          <span>{conflicts > 0 ? `Your changes conflicted when put back. Resolve and stage ${conflicts === 1 ? 'the file' : `the ${conflicts} files`} marked !` : 'A copy of your changes is still stashed. Done drops it.'}</span>
          <button disabled={conflicts > 0} onClick={p.onDropAutostash} title="Drop the saved copy from the stash">
            Done
          </button>
        </div>
      )}
      {state && (
        <div class="banner">
          <span>
            {state === 'merge' ? 'Merge' : state === 'rebase' ? 'Rebase' : state === 'cherry-pick' ? 'Cherry-pick' : 'Revert'} in progress
            {conflicts > 0 ? `, ${conflicts} conflicted file${conflicts === 1 ? '' : 's'} to resolve and stage` : ''}
          </span>
          {p.onContinue && (
            <button disabled={conflicts > 0} onClick={p.onContinue}>
              Continue
            </button>
          )}
          {p.onAbort && (
            <button class="danger" onClick={p.onAbort}>
              Abort
            </button>
          )}
        </div>
      )}
      <div class="commit-box">
        {!p.data.headBranch && p.data.headOid && <div class="warn">Not on a branch (detached HEAD)</div>}
        <div class="label">
          Message
          {p.onAiCommit && (
            <button
              class={`icon ${p.aiDrafting ? 'spin' : ''}`}
              disabled={s.staged.length === 0 && !p.aiDrafting}
              title={p.aiDrafting ? 'Drafting. Click to stop' : s.staged.length ? 'Draft the message with your AI agent' : 'Stage something first'}
              aria-label={p.aiDrafting ? 'Stop drafting' : 'Draft the message with your AI agent'}
              onClick={p.onAiCommit}
            >
              <Icon name={p.aiDrafting ? 'loading' : 'sparkle'} />
            </button>
          )}
        </div>
        <input placeholder="Summary" value={p.summary} onInput={(e) => p.onSummary((e.target as HTMLInputElement).value)} />
        <textarea placeholder="Description" value={p.description} onInput={(e) => p.onDescription((e.target as HTMLTextAreaElement).value)} />
        {p.summary.length > 72 && <div class="warn">{p.summary.length}/72: other tools cut longer summaries</div>}
        <div class="actions">
          <label>
            <input type="checkbox" checked={p.amend} onChange={(e) => p.onAmend((e.target as HTMLInputElement).checked)} style={{ width: 'auto' }} /> Amend
          </label>
          <span class="right" />
          <button class="primary" disabled={!canCommit} onClick={p.onCommit} title={why}>
            <Icon name="check" />
            <span>{label}</span>
          </button>
        </div>
      </div>
      <div class="files staging">
        <div class="fhead">
          Changes
          <span class="count">{s.unstaged.length}</span>
          <span class="spacer" />
          {treeToggle}
          {s.unstaged.length > 0 && (
            <button class="icon" title="Stage everything" onClick={p.onStageAll}>
              <Icon name="add" />
            </button>
          )}
        </div>
        <FileList
          files={s.unstaged}
          tree={p.tree}
          isSelected={(f) => isSel('unstaged', f.path)}
          onPick={(f) => p.onSelectFile({ area: { kind: 'unstaged' }, path: f.path })}
          onMenu={(e, f) => p.onFileMenu(e, f, { kind: 'unstaged' })}
          actions={(f) => (
            <>
              {f.conflict && p.onAiFix && (
                <button title="Fix the conflict with your AI agent" aria-label={`Fix the conflict in ${f.path} with your AI agent`} onClick={(e) => (e.stopPropagation(), p.onAiFix!(f.path))}>
                  <Icon name="sparkle" />
                </button>
              )}
              <button title="Discard changes" onClick={(e) => (e.stopPropagation(), p.onDiscard([f]))}>
                <Icon name="discard" />
              </button>
              <button title="Stage" onClick={(e) => (e.stopPropagation(), p.onStage([f]))}>
                <Icon name="add" />
              </button>
            </>
          )}
        />
        <div class="gap" />
        <div class="fhead">
          Staged
          <span class="count">{s.staged.length}</span>
          <span class="spacer" />
          {s.staged.length > 0 && (
            <button class="icon" title="Unstage everything" onClick={p.onUnstageAll}>
              <Icon name="remove" />
            </button>
          )}
        </div>
        <FileList
          files={s.staged}
          tree={p.tree}
          isSelected={(f) => isSel('staged', f.path)}
          onPick={(f) => p.onSelectFile({ area: { kind: 'staged' }, path: f.path })}
          onMenu={(e, f) => p.onFileMenu(e, f, { kind: 'staged' })}
          actions={(f) => (
            <button title="Unstage" onClick={(e) => (e.stopPropagation(), p.onUnstage([f.path]))}>
              <Icon name="remove" />
            </button>
          )}
        />
      </div>
    </div>
  )
}
