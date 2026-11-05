import type { DiffArea, FileChange, RepoData, WorkStatus } from './repo'

export type RepoState = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null
export type PullMode = 'merge' | 'ff-only' | 'rebase'
export type ResetMode = 'soft' | 'mixed' | 'hard'
export type MergeResult = 'up-to-date' | 'fast-forward' | 'merged' | 'conflicts' | 'done'

export interface RemoteSwitch {
  result: 'created' | 'updated' | 'up-to-date' | 'diverged'
  local: string
  ahead?: number
  behind?: number
  stash?: 'kept' | 'conflicts'
}

export type PushResult = { result: 'pushed' } | { result: 'rejected'; ahead: number; behind: number; theirs: string }

export interface RebaseResult {
  result: 'done' | 'conflicts' | 'stash-conflicts'
  before: string
}

export type AiTask = 'commit' | 'branch' | 'conflict'

export interface AiSettings {
  enabled?: boolean
  agent?: string
  prompts: Partial<Record<AiTask, string>>
}

export interface AiInfo {
  agents: { id: string; name: string }[]
  settings: AiSettings
}

export interface FileVersions {
  old: string
  new: string
  binary: boolean
}

export type TermKind = 'agent' | 'shell'

export interface TermTab {
  id: string
  kind: TermKind
  agent?: string
  /** the title the program gave its terminal, such as Claude Code's name for the conversation */
  title?: string
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export type PrChange = 'ready' | 'draft' | 'close' | 'reopen'

export type CheckState = 'pass' | 'fail' | 'running' | 'cancelled' | 'skipped'

export interface PullRequestDetail {
  number: number
  title: string
  body: string
  url: string
  state: PullRequest['state']
  author: string
  head: string
  base: string
  createdAt: string
  reviewDecision: string
  mergeState: string
  checks: { name: string; workflow: string; state: CheckState; url: string }[]
}

export interface PrNote {
  id: string
  author: string
  avatar: string
  bot: boolean
  text: string
  html: string
  url: string
  at: string
}

export interface PrThread {
  id: string
  path: string
  line: number | null
  startLine: number | null
  resolved: boolean
  outdated: boolean
  hunk: string
  notes: PrNote[]
}

export interface PrConversation {
  text: string
  html: string
  avatar: string
  comments: PrNote[]
  reviews: (PrNote & { state: string })[]
  threads: PrThread[]
}

export interface PullRequest {
  number: number
  title: string
  url: string
  branch: string
  /** the commit the pull request's branch pointed at, which is what a merged one merged */
  oid?: string
  /** the branch it merges into */
  base?: string
  state: 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED'
}

export interface Backend {
  native: boolean
  load(limit: number): Promise<RepoData>
  /** starts a repository in a folder that has none */
  init?(): Promise<void>
  status(): Promise<WorkStatus>
  files(): Promise<string[]>
  prs?(): Promise<PullRequest[]>
  prMerge?(number: number, method: MergeMethod): Promise<void>
  prView?(number: number): Promise<PullRequestDetail>
  prConversation?(number: number): Promise<PrConversation>
  prChange?(number: number, action: PrChange): Promise<void>
  commitFiles(oid: string): Promise<FileChange[]>
  fileVersions(area: DiffArea, path: string): Promise<FileVersions>
  writeIndex(path: string, content: string, expected?: string): Promise<void>
  writeWorkdir(path: string, content: string, expected?: string): Promise<void>
  stage(files: FileChange[]): Promise<void>
  unstage(paths: string[]): Promise<void>
  discard(files: FileChange[]): Promise<void>
  commit(message: string, amend: boolean): Promise<unknown>
  checkoutBranch(name: string): Promise<void>
  checkoutRemote(name: string): Promise<RemoteSwitch | void>
  checkoutCommit(oid: string): Promise<void>
  createBranch(name: string, at: string, checkout: boolean): Promise<void>
  deleteBranch(name: string): Promise<void>
  deleteRemoteBranch?(name: string): Promise<void>
  renameBranch(oldName: string, newName: string): Promise<void>
  createTag(name: string, at: string, message: string): Promise<void>
  deleteTag(name: string): Promise<void>
  stashSave(message: string): Promise<void>
  stashApply(index: number, pop: boolean): Promise<void>
  stashDrop(index: number): Promise<void>
  merge(branch: string, head: string): Promise<MergeResult>
  reset(head: string, oid: string, mode: ResetMode): Promise<void>
  fetchAll(): Promise<void>
  pull(mode: PullMode, head: string): Promise<void>
  push(head: string, lease?: string): Promise<PushResult | void>
  rebase?(onto: string): Promise<RebaseResult>
  undoRebase?(before: string): Promise<'done' | 'stash-conflicts'>
  dropAutostash?(): Promise<void>
  cherryPick?(oid: string): Promise<MergeResult>
  revert?(oid: string): Promise<MergeResult>
  abort?(): Promise<void>
  continueOp?(): Promise<void>
  openPath?(path: string): Promise<void>
  subscribe?(onChange: () => void): () => void
  ai?(): Promise<AiInfo>
  setAi?(settings: AiSettings): Promise<void>
  aiContext?(task: 'commit' | 'branch', at?: string): Promise<string>
  aiAsk?(agent: string, prompt: string, signal: AbortSignal): Promise<string>
  termStart?(id: string, kind: TermKind, agent: string | undefined, cols: number, rows: number): Promise<{ agent?: string; fresh: boolean }>
  termList?(): Promise<TermTab[]>
  termInput?(id: string, data: string): Promise<void>
  termResize?(id: string, cols: number, rows: number): Promise<void>
  termStop?(id?: string): Promise<void>
  termStream?(id: string, onData: (data: string) => void, onExit: () => void): () => void
}
