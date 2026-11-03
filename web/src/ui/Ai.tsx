import { useEffect, useRef, useState } from 'preact/hooks'
import { DEFAULT_PROMPTS } from '../git/ai'
import type { AiInfo, AiSettings, AiTask, Backend, TermKind } from '../git/backend'
import { COLORS } from '../git/scheme'
import { Buttons, Frame } from './Dialogs'

const PROMPT_LABELS: Record<AiTask, string> = {
  commit: 'Commit message prompt',
  branch: 'Branch name prompt',
  conflict: 'Conflict prompt, pasted into the agent terminal ({file} becomes the path)',
}

const names = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`)

export function AiConsent(p: { agents: AiInfo['agents']; onAnswer: (choice?: string | false) => void }) {
  const [agent, setAgent] = useState(p.agents[0]?.id)
  const chosen = p.agents.find((a) => a.id === agent)
  return (
    <Frame title="Use an AI agent?" cls="ai" onClose={() => p.onAnswer()}>
      <div>
        Ramulus found {names(p.agents.map((a) => a.name))} on this computer. The one you pick drafts commit messages and branch names for you to review, and runs in a terminal panel where you can chat with it and have it fix conflicts with its own tools.
      </div>
      <div>It uses its own sign-in, so you need no API key. The changes involved are sent to it, and it asks for your approval the same way it does in your own terminal.</div>
      {p.agents.length > 1 && (
        <div class="choices" role="radiogroup" aria-label="Agent">
          {p.agents.map((a) => (
            <label key={a.id}>
              <input type="radio" name="ai-agent" checked={agent === a.id} onChange={() => setAgent(a.id)} /> {a.name}
            </label>
          ))}
        </div>
      )}
      <div class="hint">You can change this later from AI agent settings in the command palette.</div>
      <div class="buttons">
        <button onClick={() => p.onAnswer(false)}>Turn off</button>
        <button onClick={() => p.onAnswer()}>Not now</button>
        <button class="primary" onClick={() => p.onAnswer(agent)}>
          Use {chosen?.name}
        </button>
      </div>
    </Frame>
  )
}

export function AiSettingsDialog(p: { info: AiInfo; onSave: (s: AiSettings) => void; onClose: () => void }) {
  const [s, setS] = useState<AiSettings>(p.info.settings)
  const agents = p.info.agents
  const setPrompt = (k: AiTask, v: string) => setS({ ...s, prompts: { ...s.prompts, [k]: v === DEFAULT_PROMPTS[k] ? undefined : v } })
  return (
    <Frame title="AI agent" cls="ai" onClose={p.onClose}>
      {agents.length === 0 ? (
        <div>No supported agent was found on your PATH. Ramulus looks for Claude Code, Codex, Gemini CLI and opencode, and uses the sign-in each one already has.</div>
      ) : (
        <>
          <label>
            <input type="checkbox" checked={s.enabled === true} onChange={(e) => setS({ ...s, enabled: (e.target as HTMLInputElement).checked, agent: s.agent ?? agents[0].id })} /> Let an AI agent help with commit messages, branch names and conflicts
          </label>
          {s.enabled && agents.length > 1 && (
            <div class="choices" role="radiogroup" aria-label="Agent">
              {agents.map((a) => (
                <label key={a.id}>
                  <input type="radio" name="ai-agent" checked={s.agent === a.id} onChange={() => setS({ ...s, agent: a.id })} /> {a.name}
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {(Object.keys(PROMPT_LABELS) as AiTask[]).map((k) => (
        <div key={k} class="ai-prompt">
          <div class="label">
            {PROMPT_LABELS[k]}
            {s.prompts[k] && (
              <button class="ghost" onClick={() => setPrompt(k, DEFAULT_PROMPTS[k])}>
                Reset
              </button>
            )}
          </div>
          <textarea value={s.prompts[k] ?? DEFAULT_PROMPTS[k]} onInput={(e) => setPrompt(k, (e.target as HTMLTextAreaElement).value)} />
        </div>
      ))}
      <div class="hint">Ramulus adds the staged changes or the branch names after the first two prompts.</div>
      <Buttons ok="Save" enabled={true} onOk={() => (p.onSave(s), p.onClose())} onClose={p.onClose} />
    </Frame>
  )
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const ANSI = [...COLORS, ...COLORS.map((c) => `bright${c[0].toUpperCase()}${c.slice(1)}`)]

export function AgentTerminal(p: {
  be: Backend
  id: string
  kind: TermKind
  agent?: string
  look: string
  focus: boolean
  paste?: { id: number; text: string }
  restart: number
  onState: (s: { running: boolean; agent?: string }) => void
  onFocused: () => void
  onPasted: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<{ paste: (t: string) => void; focus: () => void; setTheme: () => void; restart: () => void } | undefined>(undefined)
  const ready = useRef<Promise<void> | undefined>(undefined)
  const latest = useRef(p)
  latest.current = p

  useEffect(() => {
    let gone = false
    let cleanup = () => {}
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-webgl'), import('@xterm/xterm/css/xterm.css')]).then(([{ Terminal }, { FitAddon }, { WebglAddon }]) => {
      const el = host.current
      if (gone || !el) return
      const theme = () => {
        const ansi = ANSI.map((name, i) => [name, cssVar(`--ansi-${i}`) || undefined])
        return { background: cssVar('--bg'), foreground: cssVar('--fg'), cursor: cssVar('--fg'), selectionBackground: cssVar('--selected'), ...Object.fromEntries(ansi) }
      }
      const xt = new Terminal({ fontFamily: cssVar('--mono') || 'monospace', fontSize: 12, cursorBlink: true, theme: theme() })
      const fit = new FitAddon()
      xt.loadAddon(fit)
      xt.open(el)
      // the GPU renderer; when its context is lost, xterm's DOM renderer takes over
      try {
        const gl = new WebglAddon()
        gl.onContextLoss(() => gl.dispose())
        xt.loadAddon(gl)
      } catch {}
      fit.fit()
      let pending = ''
      let sending = false
      let session: Promise<unknown> = Promise.resolve()
      const flush = async () => {
        if (sending) return
        sending = true
        // The helper drops input for a session it has not started yet, and the keyboard arrives first.
        await session.catch(() => {})
        while (pending) {
          const data = pending
          pending = ''
          await latest.current.be.termInput!(latest.current.id, data).catch(() => {})
        }
        sending = false
      }
      const send = (d: string) => {
        pending += d
        flush()
      }
      xt.onData(send)
      // a backslash before Return is Claude Code's newline in every terminal, so Shift+Enter and Option+Enter send that
      xt.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && e.key === 'Enter' && (e.shiftKey || e.altKey)) {
          e.preventDefault()
          send('\\\r')
          return false
        }
        return true
      })
      // a pasted image reaches Claude Code as its Ctrl+V, and it takes the picture from the clipboard itself
      el.addEventListener(
        'paste',
        (e) => {
          if (![...(e.clipboardData?.items ?? [])].some((i) => i.type.startsWith('image/'))) return
          e.preventDefault()
          e.stopPropagation()
          send('\x16')
        },
        true,
      )
      let lastOutput = 0
      let detach = () => {}
      const start = async () => {
        detach()
        try {
          const r = await (session = latest.current.be.termStart!(latest.current.id, latest.current.kind, latest.current.agent, xt.cols, xt.rows))
          latest.current.onState({ running: true, agent: r.agent })
          lastOutput = Date.now()
          detach = latest.current.be.termStream!(
            latest.current.id,
            (d) => {
              lastOutput = Date.now()
              xt.write(d)
            },
            () => {
              latest.current.onState({ running: false })
              xt.write(`\r\n\x1b[2m[The ${latest.current.kind === 'shell' ? 'terminal' : 'agent'} exited. Press Restart to start it again.]\x1b[0m\r\n`)
            },
          )
          if (r.fresh) {
            const begun = Date.now()
            while (Date.now() - lastOutput < 1200 && Date.now() - begun < 15000) await new Promise((res) => setTimeout(res, 200))
          }
        } catch (e) {
          latest.current.onState({ running: false })
          xt.write(`\r\n\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`)
          throw e
        }
      }
      ready.current = start().catch(() => {})
      const ro = new ResizeObserver(() => {
        const before = `${xt.cols}x${xt.rows}`
        fit.fit()
        if (`${xt.cols}x${xt.rows}` !== before) latest.current.be.termResize!(latest.current.id, xt.cols, xt.rows).catch(() => {})
      })
      ro.observe(el)
      term.current = {
        paste: (t) => xt.paste(t),
        focus: () => xt.focus(),
        setTheme: () => (xt.options.theme = theme()),
        restart: () => {
          detach()
          detach = () => {}
          ready.current = latest.current
            .be.termStop!(latest.current.id)
            .catch(() => {})
            .then(() => (xt.reset(), start()))
            .catch(() => {})
        },
      }
      if (latest.current.focus) {
        xt.focus()
        latest.current.onFocused()
      }
      cleanup = () => {
        ro.disconnect()
        detach()
        xt.dispose()
      }
    })
    return () => {
      gone = true
      cleanup()
    }
  }, [])

  useEffect(() => {
    term.current?.setTheme()
  }, [p.look])

  useEffect(() => {
    if (p.restart) term.current?.restart()
  }, [p.restart])

  useEffect(() => {
    if (!p.focus || !term.current) return
    term.current.focus()
    p.onFocused()
  }, [p.focus])

  useEffect(() => {
    const text = p.paste?.text
    if (!text) return
    let live = true
    const go = async () => {
      while (live && !term.current) await new Promise((res) => setTimeout(res, 100))
      await ready.current
      if (!live) return
      term.current?.paste(text)
      term.current?.focus()
      latest.current.onPasted()
    }
    go()
    return () => {
      live = false
    }
  }, [p.paste?.id])

  return <div class="agent-term" ref={host} />
}
