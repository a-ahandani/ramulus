import { useEffect, useRef, useState } from 'preact/hooks'
import { DEFAULT_PROMPTS } from '../git/ai'
import type { AiInfo, AiSettings, AiTask, Backend, TermKind, TermLink } from '../git/backend'
import { COLORS } from '../git/scheme'
import { Icon, webUrl } from './bits'
import { Buttons, Frame } from './Dialogs'

const PROMPT_LABELS: Record<AiTask, string> = {
  commit: 'Commit message prompt',
  branch: 'Branch name prompt',
  conflict: 'Conflict prompt ({file} is the path)',
}

export function AiConsent(p: { agents: AiInfo['agents']; onAnswer: (choice?: string | false) => void }) {
  const [agent, setAgent] = useState(p.agents[0]?.id)
  const chosen = p.agents.find((a) => a.id === agent)
  return (
    <Frame title="Use an AI agent?" cls="ai" onClose={() => p.onAnswer()}>
      <div class="ai-perks">
        <span>
          <Icon name="edit" />
          Commit messages
        </span>
        <span>
          <Icon name="git-branch" />
          Branch names
        </span>
        <span>
          <Icon name="terminal" />
          Chat and fix conflicts
        </span>
      </div>
      {p.agents.length > 1 && (
        <div class="choices cards" role="radiogroup" aria-label="Agent">
          {p.agents.map((a) => (
            <label key={a.id} class={agent === a.id ? 'on' : ''}>
              <input type="radio" name="ai-agent" checked={agent === a.id} onChange={() => setAgent(a.id)} /> {a.name}
            </label>
          ))}
        </div>
      )}
      <div class="hint">It uses its own sign-in, sees the changes involved, and asks before it edits anything.</div>
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
        <div>No agent found on your PATH. Install Claude Code, Codex, Gemini CLI or opencode.</div>
      ) : (
        <>
          <label>
            <input type="checkbox" checked={s.enabled === true} onChange={(e) => setS({ ...s, enabled: (e.target as HTMLInputElement).checked, agent: s.agent ?? agents[0].id })} /> Use an AI agent
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
      <div class="hint">The staged changes or branch names follow the first two prompts.</div>
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
  resume?: string
  look: string
  /** whether this tab is the one showing; the others stay alive behind it, so switching to one is instant */
  shown: boolean
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
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-webgl'), import('@xterm/addon-web-links'), import('@xterm/xterm/css/xterm.css')]).then(([{ Terminal }, { FitAddon }, { WebglAddon }, { WebLinksAddon }]) => {
      const el = host.current
      if (gone || !el) return
      const theme = () => {
        const ansi = ANSI.map((name, i) => [name, cssVar(`--ansi-${i}`) || undefined])
        return { background: cssVar('--bg'), foreground: cssVar('--fg'), cursor: cssVar('--fg'), selectionBackground: cssVar('--selected'), ...Object.fromEntries(ansi) }
      }
      // A web link opens in the browser on ⌘-click (Ctrl-click elsewhere), as in other terminals, so a plain click
      // still selects text and reaches the program. It is the links a program marks (OSC 8) or any URL it prints.
      const follow = (e: MouseEvent, uri: string) => {
        const url = webUrl(uri)
        if (url && (e.metaKey || e.ctrlKey)) window.open(url, '_blank', 'noopener,noreferrer')
      }
      const hint = { hover: () => (el.title = `${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}-click to open the link`), leave: () => el.removeAttribute('title') }
      const xt = new Terminal({ fontFamily: cssVar('--mono') || 'monospace', fontSize: 12, cursorBlink: true, theme: theme(), linkHandler: { activate: follow, ...hint } })
      const fit = new FitAddon()
      xt.loadAddon(fit)
      xt.loadAddon(new WebLinksAddon(follow, hint))
      xt.open(el)
      // The GPU renderer, made again whenever the tab shows without one: past the browser's limit on contexts, the
      // oldest tab loses its own and xterm's DOM renderer takes over until then.
      let gl: { dispose(): void } | undefined
      // without WebGL2 it fails at once, and every try stays in xterm's add-on list, so it is tried once
      let noGpu = false
      const gpu = () => {
        if (gl || noGpu) return
        try {
          const a = new WebglAddon()
          xt.loadAddon(a)
          a.onContextLoss(() => {
            a.dispose()
            if (gl === a) gl = undefined
          })
          gl = a
        } catch {
          noGpu = true
        }
      }
      gpu()
      fit.fit()
      let link: TermLink | undefined
      // the helper drops typing for a tab it has not started yet, and the keyboard arrives first
      let pending = ''
      const send = (d: string) => (link ? link.input(d) : (pending += d))
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
      // The size the program was last given. While a splitter drags, the screen follows every frame but the program
      // hears once the size settles, so it redraws once instead of on every frame.
      let told = ''
      let telling: ReturnType<typeof setTimeout> | undefined
      const tell = () => {
        clearTimeout(telling)
        telling = setTimeout(() => {
          const size = `${xt.cols}x${xt.rows}`
          if (link && size !== told) {
            told = size
            link.resize(xt.cols, xt.rows)
          }
        }, 120)
      }
      const start = async () => {
        link?.close()
        link = undefined
        try {
          told = `${xt.cols}x${xt.rows}`
          const r = await latest.current.be.termStart!(latest.current.id, latest.current.kind, latest.current.agent, xt.cols, xt.rows, latest.current.resume)
          latest.current.onState({ running: true, agent: r.agent })
          lastOutput = Date.now()
          link = latest.current.be.termAttach!(
            latest.current.id,
            (d, replay) => {
              lastOutput = Date.now()
              // a replay is the whole screen again, after the socket came back or the tab fell behind
              if (replay) xt.reset()
              xt.write(d)
            },
            () => {
              latest.current.onState({ running: false })
              xt.write(`\r\n\x1b[2m[The ${latest.current.kind === 'shell' ? 'terminal' : 'agent'} exited. Press Restart to start it again.]\x1b[0m\r\n`)
            },
          )
          if (pending) link.input(pending)
          pending = ''
          tell()
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
        // a hidden tab has no size and lets go of the keyboard, so nothing is typed into it unseen; it fits again as it shows
        if (!el.clientWidth) {
          if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
          return
        }
        gpu()
        fit.fit()
        tell()
      })
      ro.observe(el)
      term.current = {
        paste: (t) => xt.paste(t),
        focus: () => xt.focus(),
        setTheme: () => (xt.options.theme = theme()),
        restart: () => {
          link?.close()
          link = undefined
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
        clearTimeout(telling)
        link?.close()
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

  return <div class="agent-term" hidden={!p.shown} ref={host} />
}
