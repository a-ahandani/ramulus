import type { Backend } from './backend'
import type { RefLabel, RepoData } from './repo'

async function post<T>(base: string, token: string, op: string, body: object, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${base}/api/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ramulus-token': token },
    body: JSON.stringify(body),
    signal,
  })
  const data = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))
  if (!res.ok || data.error) throw new Error(data.error ?? 'Request failed')
  return data.result as T
}

export interface RepoInfo {
  dir: string
  name: string
}

export function helperShell(base: string, token: string) {
  return {
    repos: () => post<{ current: RepoInfo | null; recent: RepoInfo[] }>(base, token, 'repos', {}),
    findRepos: () => post<{ root: string; inside: boolean; repos: RepoInfo[] }>(base, token, 'findRepos', {}),
    pins: () => post<RepoInfo[]>(base, token, 'pins', {}),
    setPins: (dirs: string[]) => post<void>(base, token, 'setPins', { dirs }),
    prefs: () => post<Record<string, unknown>>(base, token, 'prefs', {}),
    setPrefs: (prefs: Record<string, unknown>) => post<void>(base, token, 'setPrefs', { prefs }),
    openRepo: (path: string) => post<RepoInfo>(base, token, 'openRepo', { path }),
    pickFolder: () => post<string | null>(base, token, 'pickFolder', {}),
  }
}

export function httpBackend(base: string, token: string, repo?: string): Backend {
  const call = <T>(op: string, body: object = {}, signal?: AbortSignal): Promise<T> => post<T>(base, token, op, { ...body, repo }, signal)
  return {
    native: true,
    load: async (limit) => {
      const d = await call<Omit<RepoData, 'refsByOid'> & { refsByOid: Record<string, RefLabel[]> }>('load', { limit })
      return { ...d, refsByOid: new Map(Object.entries(d.refsByOid)) }
    },
    init: () => call('init'),
    status: () => call('status'),
    files: () => call('files'),
    prs: () => call('prs'),
    prMerge: (number, method) => call('prMerge', { number, method }),
    prView: (number) => call('prView', { number }),
    prConversation: (number) => call('prConversation', { number }),
    prChange: (number, action) => call('prChange', { number, action }),
    commitFiles: (oid) => call('commitFiles', { oid }),
    fileVersions: (area, path) => call('fileVersions', { area, path }),
    writeIndex: (path, content, expected) => call('writeIndex', { path, content, expected }),
    writeWorkdir: (path, content, expected) => call('writeWorkdir', { path, content, expected }),
    openPath: (path) => call('openPath', { path }),
    revealPath: (path) => call('revealPath', { path }),
    stage: (files) => call('stage', { paths: files.map((f) => f.path) }),
    unstage: (paths) => call('unstage', { paths }),
    discard: (files) => call('discard', { files }),
    commit: (message, amend) => call('commit', { message, amend }),
    checkoutBranch: (name) => call('checkoutBranch', { name }),
    checkoutRemote: (name) => call('checkoutRemote', { name }),
    checkoutCommit: (oid) => call('checkoutCommit', { oid }),
    createBranch: (name, at, checkout) => call('createBranch', { name, at, checkout }),
    deleteBranch: (name) => call('deleteBranch', { name }),
    ciRuns: () => call('ciRuns'),
    deleteRemoteBranch: (name) => call('deleteRemoteBranch', { name }),
    renameBranch: (oldName, newName) => call('renameBranch', { oldName, newName }),
    createTag: (name, at, message) => call('createTag', { name, at, message }),
    deleteTag: (name) => call('deleteTag', { name }),
    stashSave: (message) => call('stashSave', { message }),
    stashApply: (index, pop) => call('stashApply', { index, pop }),
    stashDrop: (index) => call('stashDrop', { index }),
    merge: (branch) => call('merge', { branch }),
    reset: (_head, oid, mode) => call('reset', { oid, mode }),
    fetchAll: () => call('fetchAll'),
    pull: (mode) => call('pull', { mode }),
    push: (_head, lease) => call('push', { lease }),
    rebase: (onto) => call('rebase', { onto }),
    undoRebase: (before) => call('undoRebase', { before }),
    dropAutostash: () => call('dropAutostash'),
    cherryPick: (oid) => call('cherryPick', { oid }),
    revert: (oid) => call('revert', { oid }),
    abort: () => call('abort'),
    continueOp: () => call('continue'),
    ai: () => call('ai'),
    setAi: (settings) => call('setAi', { settings }),
    aiContext: (task, at) => call('aiContext', { task, at }),
    aiAsk: (agent, prompt, signal) => call('aiAsk', { agent, prompt }, signal),
    termStart: (id, kind, agent, cols, rows, resume) => call('termStart', { id, kind, agent, cols, rows, resume }),
    agentSessions: () => call('agentSessions'),
    termList: () => call('termList'),
    termInput: (id, data) => call('termInput', { id, data }),
    termResize: (id, cols, rows) => call('termResize', { id, cols, rows }),
    termStop: (id) => call('termStop', id ? { id } : { all: true }),
    termStream: (id, onData, onExit) => {
      const es = new EventSource(`${base}/api/term?token=${token}&id=${id}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`)
      es.onmessage = (e) => onData(JSON.parse(e.data))
      es.addEventListener('exit', () => {
        es.close()
        onExit()
      })
      return () => es.close()
    },
    subscribe: (onChange) => {
      const es = new EventSource(`${base}/api/events?token=${token}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`)
      es.onmessage = () => onChange()
      return () => es.close()
    },
  }
}
