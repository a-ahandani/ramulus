import { execFile } from 'node:child_process'
import { findBin } from './ai.js'

const FRESH_MS = 60000
const FIELDS = 'number,title,url,headRefName,headRefOid,baseRefName,state,isDraft'
const METHODS = ['merge', 'squash', 'rebase']
const cache = new Map()

const gh = (bin, args, dir, env) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { cwd: dir, env: { ...env, GH_PROMPT_DISABLED: '1' }, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout),
    ),
  )

async function ghSignedIn(args, dir, env) {
  const bin = findBin('gh', env)
  if (!bin) throw new Error('The GitHub CLI (gh) is not installed')
  const { GITHUB_TOKEN, GH_TOKEN, ...signedIn } = env
  return gh(bin, args, dir, env).catch((e) => {
    if ((GITHUB_TOKEN || GH_TOKEN) && /401|403|bad credentials|not accessible|authenticat/i.test(e.message)) return gh(bin, args, dir, signedIn)
    throw e
  })
}

async function load(dir, env) {
  try {
    const out = await ghSignedIn(['pr', 'list', '--state', 'all', '--limit', '100', '--json', FIELDS], dir, env)
    return JSON.parse(out).map(({ number, title, url, headRefName, headRefOid, baseRefName, state, isDraft }) => ({ number, title, url, branch: headRefName, oid: headRefOid, base: baseRefName, state: state === 'OPEN' && isDraft ? 'DRAFT' : state }))
  } catch {
    return []
  }
}

const RUN_FIELDS = 'headSha,status,conclusion,workflowName,url'
// the app asks again every few seconds while a run is going, so this cache is short
const RUNS_FRESH_MS = 10000
const runsCache = new Map()
const RUN_CONCLUSION = { success: 'pass', failure: 'fail', timed_out: 'fail', action_required: 'fail', startup_failure: 'fail', cancelled: 'cancelled' }

async function loadRuns(dir, env) {
  try {
    const out = await ghSignedIn(['run', 'list', '--limit', '100', '--json', RUN_FIELDS], dir, env)
    const seen = new Set()
    // newest first, so a later run of the same workflow on the same commit hides the one before
    return JSON.parse(out).flatMap((r) => {
      const k = `${r.headSha}\n${r.workflowName}`
      if (seen.has(k)) return []
      seen.add(k)
      return [{ sha: r.headSha, workflow: r.workflowName, state: r.status !== 'completed' ? 'running' : (RUN_CONCLUSION[r.conclusion] ?? 'skipped'), url: r.url }]
    })
  } catch {
    return []
  }
}

/** The repository's recent GitHub Actions runs, one per commit and workflow; empty without gh or GitHub. */
export function ciRuns(dir, env = process.env) {
  const hit = runsCache.get(dir)
  if (hit && Date.now() - hit.at < RUNS_FRESH_MS) return hit.list
  const list = loadRuns(dir, env)
  runsCache.set(dir, { at: Date.now(), list })
  return list
}

export function pullRequests(dir, env = process.env) {
  const hit = cache.get(dir)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.list
  const list = load(dir, env)
  cache.set(dir, { at: Date.now(), list })
  return list
}

const VIEW_FIELDS = 'number,title,body,state,isDraft,author,headRefName,baseRefName,url,createdAt,reviewDecision,mergeStateStatus,statusCheckRollup'
const STATUS = { SUCCESS: 'pass', FAILURE: 'fail', ERROR: 'fail', PENDING: 'running', EXPECTED: 'running' }
const CONCLUSION = { SUCCESS: 'pass', FAILURE: 'fail', TIMED_OUT: 'fail', ACTION_REQUIRED: 'fail', STARTUP_FAILURE: 'fail', CANCELLED: 'cancelled' }

const checkState = (c) => (c.__typename === 'StatusContext' ? (STATUS[c.state] ?? 'running') : c.status !== 'COMPLETED' ? 'running' : (CONCLUSION[c.conclusion] ?? 'skipped'))
const who = (a) => a?.login ?? 'unknown'

const VIEW_FRESH_MS = 20000
const views = new Map()

const forget = (dir) => {
  cache.delete(dir)
  for (const k of [...views.keys()]) if (k.startsWith(`${dir}\n`)) views.delete(k)
}

function fresh(k, number, read) {
  if (!Number.isInteger(number) || number < 1) return Promise.reject(new Error('Invalid pull request number'))
  const hit = views.get(k)
  if (hit && Date.now() - hit.at < VIEW_FRESH_MS) return hit.view
  const view = read()
  views.set(k, { at: Date.now(), view })
  view.catch(() => views.get(k)?.view === view && views.delete(k))
  return view
}

export const pullRequest = (dir, number, env = process.env) => fresh(`${dir}\n${number}`, number, () => readPullRequest(dir, number, env))
export const prConversation = (dir, number, env = process.env) => fresh(`${dir}\n${number}\nconversation`, number, () => readConversation(dir, number, env))

async function readPullRequest(dir, number, env) {
  const v = JSON.parse(await ghSignedIn(['pr', 'view', String(number), '--json', VIEW_FIELDS], dir, env))
  return {
    number: v.number,
    title: v.title,
    body: v.body ?? '',
    url: v.url,
    state: v.state === 'OPEN' && v.isDraft ? 'DRAFT' : v.state,
    author: who(v.author),
    head: v.headRefName,
    base: v.baseRefName,
    createdAt: v.createdAt,
    reviewDecision: v.reviewDecision ?? '',
    mergeState: v.mergeStateStatus ?? '',
    checks: (v.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? 'Check', workflow: c.workflowName ?? '', state: checkState(c), url: c.detailsUrl ?? c.targetUrl ?? '' })),
  }
}

const NOTE = 'id body bodyHTML url author{__typename login avatarUrl(size:56)}'
// shortcut: reads the newest 100 of each list and 50 replies per thread, page through them if a pull request outgrows that.
const CONVERSATION = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  body
  bodyHTML
  author{avatarUrl(size:56)}
  comments(last:100){nodes{${NOTE} createdAt}}
  reviews(last:100){nodes{${NOTE} state submittedAt}}
  reviewThreads(last:100){nodes{id path line startLine originalLine originalStartLine isResolved isOutdated comments(first:50){nodes{${NOTE} createdAt diffHunk}}}}
}}}`

const note = (n) => ({ id: n.id, author: who(n.author), avatar: n.author?.avatarUrl ?? '', bot: n.author?.__typename === 'Bot', text: n.body ?? '', html: n.bodyHTML ?? '', url: n.url, at: n.createdAt ?? n.submittedAt })

async function readConversation(dir, number, env) {
  const { url } = await pullRequest(dir, number, env)
  const { hostname, pathname } = new URL(url)
  const [, owner, name] = pathname.split('/')
  const out = await ghSignedIn(['api', 'graphql', '--hostname', hostname, '-f', `query=${CONVERSATION}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`], dir, env)
  const pr = JSON.parse(out).data.repository.pullRequest
  return {
    text: pr.body ?? '',
    html: pr.bodyHTML ?? '',
    avatar: pr.author?.avatarUrl ?? '',
    comments: pr.comments.nodes.map(note),
    // A COMMENTED review with no text only wraps its inline comments, which already show as threads.
    reviews: pr.reviews.nodes.filter((r) => r.state !== 'PENDING' && (r.state !== 'COMMENTED' || r.body?.trim())).map((r) => ({ ...note(r), state: r.state })),
    threads: pr.reviewThreads.nodes
      .filter((t) => t.comments.nodes.length)
      .map((t) => ({ id: t.id, path: t.path, line: t.line ?? t.originalLine, startLine: t.startLine ?? t.originalStartLine, resolved: t.isResolved, outdated: t.isOutdated, hunk: t.comments.nodes[0].diffHunk ?? '', notes: t.comments.nodes.map(note) })),
  }
}

const CHANGES = { ready: ['ready'], draft: ['ready', '--undo'], close: ['close'], reopen: ['reopen'] }

export async function changePullRequest(dir, number, action, env = process.env) {
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid pull request number')
  if (!Object.hasOwn(CHANGES, action)) throw new Error('Invalid pull request action')
  const [verb, ...flags] = CHANGES[action]
  try {
    await ghSignedIn(['pr', verb, String(number), ...flags], dir, env)
  } finally {
    forget(dir)
  }
}

export async function mergePullRequest(dir, number, method, env = process.env) {
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid pull request number')
  if (!METHODS.includes(method)) throw new Error('Invalid merge method')
  try {
    await ghSignedIn(['pr', 'merge', String(number), `--${method}`], dir, env)
  } finally {
    forget(dir)
  }
}
