import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { agentSessions } from '../lib/sessions.js'
import { claudeBusy, createTerminals } from '../lib/term.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ramulus-sessions-')))
after(() => rmSync(root, { recursive: true, force: true }))

const repo = join(root, 'my.repo')
const bin = join(root, 'bin')
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') }
const none = { ids: new Set(), since: new Map() }
const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const X1 = '019f0000-0000-7000-8000-000000000001'
const X2 = '019f0000-0000-7000-8000-000000000002'

const file = (path, lines, at) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  utimesSync(path, at, at)
}
const stub = (name, script) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}`)
  chmodSync(join(bin, name), 0o755)
}

describe('agent sessions', { skip: process.platform === 'win32' }, () => {
  mkdirSync(repo, { recursive: true })
  mkdirSync(bin, { recursive: true })
  stub('claude', 'echo "args:$*"\ncat\n')
  stub('codex', 'echo "args:$*"\ncat\n')
  stub('opencode', `if [ "$1" = session ]; then echo '${JSON.stringify([
    { id: 'ses_abc', title: 'Tidy the docs', updated: 5000_000, created: 4000_000, directory: repo },
    { id: 'ses_other', title: 'Elsewhere', updated: 6000_000, created: 1, directory: join(root, 'other') },
  ])}'; exit 0; fi\necho "args:$*"\ncat\n`)

  const claudeDir = join(root, 'claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(join(root, 'claude', 'sessions'), { recursive: true })
  const user = (content, extra) => ({ type: 'user', cwd: repo, message: { role: 'user', content }, ...extra })
  const reply = (usage, extra) => ({ type: 'assistant', message: { role: 'assistant', usage }, ...extra })
  file(
    join(claudeDir, `${C1}.jsonl`),
    [
      { type: 'mode' },
      user('fix the\nlogin'),
      { type: 'ai-title', aiTitle: 'Old name' },
      reply({ input_tokens: 9, cache_read_input_tokens: 9 }),
      { type: 'cost-state', totalCostUSD: 0.5 },
      reply({ input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 162000, output_tokens: 500 }),
      // a subagent's request is not what the conversation carries
      reply({ input_tokens: 7 }, { isSidechain: true }),
      { type: 'cost-state', totalCostUSD: 19.41 },
      { type: 'ai-title', aiTitle: 'Login fix' },
    ],
    9000,
  )
  file(join(claudeDir, `${C2}.jsonl`), [user('<command-name>/login</command-name>'), user([{ type: 'text', text: 'add  tests\tplease' }])], 8000)
  // another folder whose name turns into the same directory name, and a conversation with nothing asked
  file(join(claudeDir, '33333333-3333-4333-8333-333333333333.jsonl'), [{ ...user('elsewhere'), cwd: join(root, 'my-repo') }], 9500)
  file(join(claudeDir, '44444444-4444-4444-8444-444444444444.jsonl'), [user('<command-name>/login</command-name>'), user('ignored', { isMeta: true })], 9600)
  // one running in a terminal outside Ramulus, and one whose process is gone
  file(join(claudeDir, '55555555-5555-4555-8555-555555555555.jsonl'), [user('still going')], 9700)
  writeFileSync(join(root, 'claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: '55555555-5555-4555-8555-555555555555' }))
  writeFileSync(join(root, 'claude', 'sessions', '999999.json'), JSON.stringify({ pid: 999999, sessionId: C1 }))

  const codexDay = join(root, 'codex', 'sessions', '2026', '11', '05')
  const meta = (id, extra) => ({ type: 'session_meta', payload: { id, cwd: repo, source: 'cli', timestamp: '2026-11-05T10:00:00Z', ...extra } })
  const asked = (message) => ({ type: 'event_msg', payload: { type: 'user_message', message } })
  const counted = (input, total) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input }, model_context_window: 258400 } } })
  file(
    join(codexDay, `rollout-a-${X1}.jsonl`),
    [meta(X1), asked('# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n## My request for Codex:\nRename the button'), counted(5000, 6000), counted(117032, 2809339), { type: 'event_msg', payload: { type: 'token_count', info: null } }],
    7000,
  )
  file(join(codexDay, `rollout-b-${X2}.jsonl`), [meta(X2, { source: 'vscode' }), asked('first try')], 6000)
  file(join(codexDay, 'rollout-c-x3.jsonl'), [meta('x3', { source: 'exec' }), asked('a script ran this')], 9900)
  file(join(codexDay, 'rollout-d-x4.jsonl'), [meta('x4', { source: { subagent: 'review' } }), asked('a helper ran this')], 9900)
  writeFileSync(join(root, 'codex', 'session_index.jsonl'), `${JSON.stringify({ id: X2, thread_name: 'Old' })}\n${JSON.stringify({ id: X2, thread_name: 'Named thread' })}\n`)

  it('lists the conversations held in a folder, newest first', async () => {
    assert.deepEqual(await agentSessions(repo, none, env), [
      { agent: 'claude', id: C1, title: 'Login fix', time: 9000_000, context: 163002, cost: 19.41 },
      { agent: 'claude', id: C2, title: 'add tests please', time: 8000_000 },
      { agent: 'codex', id: X1, title: 'Rename the button', time: 7000_000, context: 117032, window: 258400, tokens: 2809339 },
      { agent: 'codex', id: X2, title: 'Named thread', time: 6000_000 },
      { agent: 'opencode', id: 'ses_abc', title: 'Tidy the docs', time: 5000_000 },
    ])
  })

  it('leaves out what open tabs hold, and the agents that are not installed', async () => {
    // a new Codex tab started between the two Codex conversations, so the later one is its own
    const held = { ids: new Set([C1, 'ses_abc']), since: new Map([['codex', 6500_000]]) }
    assert.deepEqual((await agentSessions(repo, held, env)).map((s) => s.id), [C2, X2])
    assert.deepEqual(await agentSessions(repo, none, { ...env, PATH: '/nonexistent' }), [])
  })

  it('reads from its title whether Claude Code is working', () => {
    assert.deepEqual(['◐ Fix the login', '✳ Fix the login', 'Claude Code', '✳', undefined].map(claudeBusy), [true, false, false, false, false])
  })

  it('resumes a conversation in a new tab and counts it as held', async () => {
    const terms = createTerminals()
    const seen = (id) => {
      let out = ''
      terms.attach(repo, id, { write: (d) => (out += d) })
      return async (text) => {
        for (let i = 0; i < 100 && !out.includes(text); i++) await new Promise((r) => setTimeout(r, 50))
        assert.ok(out.includes(text), `never saw ${text}; saw ${out}`)
      }
    }
    await terms.start(repo, 'a', 'agent', 'claude', 80, 24, env, C2)
    await seen('a')(`args:--resume ${C2}`)
    await terms.start(repo, 'b', 'agent', 'codex', 80, 24, env, X1)
    await seen('b')(`args:resume ${X1}`)
    await terms.start(repo, 'c', 'agent', 'opencode', 80, 24, env, 'ses_abc')
    await seen('c')('args:--session ses_abc')
    await terms.start(repo, 'd', 'agent', 'codex', 80, 24, env)
    const held = terms.held(repo)
    assert.deepEqual([...held.ids].sort(), [C2, X1, 'ses_abc'].sort())
    assert.deepEqual([...held.since.keys()], ['codex'])
    // the others just printed, so they count as working for a minute; this Claude Code tab never showed its spinner
    assert.equal(terms.working(), true)
    assert.equal(terms.working(Date.now() + 61000), false)
    await assert.rejects(terms.start(repo, 'e', 'agent', 'codex', 80, 24, env, 'a&calc'), /cannot be resumed/)
    await assert.rejects(terms.start(repo, 'e', 'agent', 'claude', 80, 24, env, 'not-a-uuid'), /cannot be resumed/)
    terms.stopAll()
  })
})
