import type { editor } from 'monaco-editor/editor/editor.api'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { applyChange, withBom, type LineChange } from '../git/chunk'
import { Icon } from './bits'

export type DiffMode = 'inline' | 'split'

export interface ChunkAction {
  label: string
  icon: string
  into: 'a' | 'b'
  run: (text: string, base: string) => void
}

export interface DiffEditorProps {
  oldText: string
  newText: string
  filename: string
  mode: DiffMode
  look: string
  wrap: boolean
  collapse: boolean
  editable: boolean
  dirty: boolean
  actions: ChunkAction[]
  onDirty: (dirty: boolean) => void
  onSave: () => void
  handle?: (h: DiffEditorHandle) => void
  /** as tall as its content, for a list of diffs that scrolls as one */
  fit?: boolean
}

export interface DiffEditorHandle {
  next: () => void
  prev: () => void
  text: () => string
}

interface Control {
  top: number
  change: LineChange
}


export function DiffEditor(p: DiffEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const [controls, setControls] = useState<Control[]>([])
  const [fitH, setFitH] = useState<number>()
  const diffRef = useRef<{ diff: editor.IStandaloneDiffEditor; setLook: (look: string) => void } | undefined>(undefined)
  const base = useRef({ version: 0, applying: false })
  const latest = useRef(p)
  latest.current = p

  useLayoutEffect(() => {
    const parent = host.current
    if (!parent) return
    let gone = false
    let dispose = () => {}
    import('./monaco').then(({ monaco, languageFor, themeFor }) => {
      if (gone) return
      const o = latest.current
      const lang = languageFor(o.filename)
      const original = monaco.editor.createModel(o.oldText, lang)
      const modified = monaco.editor.createModel(o.newText, lang)
      const diff = monaco.editor.createDiffEditor(parent, {
        theme: themeFor(o.look),
        automaticLayout: true,
        renderSideBySide: o.mode === 'split',
        useInlineViewWhenSpaceIsLimited: false,
        originalEditable: false,
        readOnly: !o.editable,
        ignoreTrimWhitespace: false,
        renderMarginRevertIcon: false,
        renderGutterMenu: false,
        diffWordWrap: o.wrap ? 'on' : 'off',
        hideUnchangedRegions: { enabled: o.collapse },
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fixedOverflowWidgets: true,
        // a diff sized to its content lets the wheel scroll the list it sits in
        scrollbar: o.fit ? { alwaysConsumeMouseWheel: false } : undefined,
      })
      diff.setModel({ original, modified })
      const mod = diff.getModifiedEditor()
      base.current.version = modified.getAlternativeVersionId()
      const measure = () => {
        const lh = mod.getOption(monaco.editor.EditorOption.lineHeight)
        const offset = (mod.getDomNode()?.getBoundingClientRect().top ?? 0) - parent.getBoundingClientRect().top - mod.getScrollTop()
        const count = modified.getLineCount()
        const inline = latest.current.mode === 'inline'
        setControls(
          (diff.getLineChanges() ?? []).map((c) => {
            const removed = c.originalEndLineNumber === 0 ? 0 : c.originalEndLineNumber - c.originalStartLineNumber + 1
            const after = c.modifiedStartLineNumber + 1
            const top =
              c.modifiedEndLineNumber === 0
                ? (after > count ? mod.getTopForLineNumber(count) + lh : mod.getTopForLineNumber(after)) - removed * lh
                : mod.getTopForLineNumber(c.modifiedStartLineNumber) - (inline ? removed * lh : 0)
            return { top: offset + top, change: c }
          }),
        )
      }
      const fit = () => {
        if (!latest.current.fit) return
        const orig = diff.getOriginalEditor().getContentHeight()
        setFitH(latest.current.mode === 'inline' ? mod.getContentHeight() : Math.max(orig, mod.getContentHeight()))
      }
      let first = true
      const subs = [
        modified.onDidChangeContent(() => base.current.applying || latest.current.onDirty(modified.getAlternativeVersionId() !== base.current.version)),
        diff.onDidUpdateDiff(() => {
          measure()
          fit()
          // opens at the first change rather than at line 1
          if (first && !latest.current.fit && diff.getLineChanges()?.length) diff.revealFirstDiff()
          first = false
        }),
        mod.onDidContentSizeChange(fit),
        diff.getOriginalEditor().onDidContentSizeChange(fit),
        mod.onDidScrollChange(measure),
        mod.onDidLayoutChange(measure),
        mod.addAction({ id: 'ramulus.save', label: 'Save', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => latest.current.onSave() }),
      ]
      diffRef.current = { diff, setLook: (look) => monaco.editor.setTheme(themeFor(look)) }
      latest.current.handle?.({
        next: () => diff.goToDiff('next'),
        prev: () => diff.goToDiff('previous'),
        text: () => modified.getValue(undefined, true),
      })
      dispose = () => {
        subs.forEach((s) => s.dispose())
        diff.dispose()
        original.dispose()
        modified.dispose()
      }
    })
    return () => {
      gone = true
      dispose()
      diffRef.current = undefined
      setControls([])
    }
  }, [p.filename, p.editable])

  useEffect(() => {
    const model = diffRef.current?.diff.getModel()
    if (!model) return
    const oldChanged = model.original.getValue(undefined, true) !== p.oldText
    const newChanged = model.modified.getValue(undefined, true) !== p.newText
    if (newChanged && model.modified.getAlternativeVersionId() !== base.current.version) return
    if (oldChanged || newChanged) setControls([])
    if (oldChanged) model.original.setValue(p.oldText)
    base.current.applying = true
    if (newChanged) model.modified.setValue(p.newText)
    base.current.applying = false
    base.current.version = model.modified.getAlternativeVersionId()
    p.onDirty(false)
  }, [p.oldText, p.newText])

  useEffect(() => {
    const d = diffRef.current
    if (!d) return
    d.diff.updateOptions({ renderSideBySide: p.mode === 'split', diffWordWrap: p.wrap ? 'on' : 'off', hideUnchangedRegions: { enabled: p.collapse } })
    d.setLook(p.look)
  }, [p.mode, p.wrap, p.collapse, p.look])

  const runAction = (a: ChunkAction, change: LineChange) => {
    const model = diffRef.current?.diff.getModel()
    if (!model) return
    const target = a.into === 'a' ? model.original : model.modified
    const raw = target.getValue(undefined, true)
    a.run(withBom(raw, applyChange(model.original.getLinesContent(), model.modified.getLinesContent(), change, a.into, target.getEOL())), raw)
  }

  return (
    <div class={`diff-editor ${p.mode} ${p.fit ? 'fit' : ''}`} style={p.fit ? { height: `${fitH ?? 120}px` } : undefined}>
      <div class="mo-host" ref={host} />
      {p.actions.length > 0 &&
        controls.map((c, i) => (
          <div class="chunk-ctl" key={i} style={{ top: `${c.top}px` }}>
            {p.actions.map((a) => (
              <button key={a.label} class="icon" disabled={p.dirty} title={p.dirty ? 'Save or revert your edits first' : a.label} onClick={() => runAction(a, c.change)}>
                <Icon name={a.icon} />
              </button>
            ))}
          </div>
        ))}
    </div>
  )
}

export function FileEditor(p: {
  text: string
  filename: string
  look: string
  wrap: boolean
  editable: boolean
  onDirty: (dirty: boolean) => void
  onSave: () => void
  handle?: (h: DiffEditorHandle) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const ed = useRef<{ editor: editor.IStandaloneCodeEditor; setLook: (look: string) => void } | undefined>(undefined)
  const base = useRef({ version: 0, applying: false })
  const latest = useRef(p)
  latest.current = p

  useLayoutEffect(() => {
    const parent = host.current
    if (!parent) return
    let gone = false
    let dispose = () => {}
    import('./monaco').then(({ monaco, languageFor, themeFor }) => {
      if (gone) return
      const o = latest.current
      const model = monaco.editor.createModel(o.text, languageFor(o.filename))
      const code = monaco.editor.create(parent, {
        model,
        theme: themeFor(o.look),
        automaticLayout: true,
        readOnly: !o.editable,
        wordWrap: o.wrap ? 'on' : 'off',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fixedOverflowWidgets: true,
      })
      base.current.version = model.getAlternativeVersionId()
      const subs = [
        model.onDidChangeContent(() => base.current.applying || latest.current.onDirty(model.getAlternativeVersionId() !== base.current.version)),
        code.addAction({ id: 'ramulus.save', label: 'Save', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => latest.current.onSave() }),
      ]
      ed.current = { editor: code, setLook: (look) => monaco.editor.setTheme(themeFor(look)) }
      latest.current.handle?.({ next: () => {}, prev: () => {}, text: () => model.getValue(undefined, true) })
      dispose = () => {
        subs.forEach((s) => s.dispose())
        code.dispose()
        model.dispose()
      }
    })
    return () => {
      gone = true
      dispose()
      ed.current = undefined
    }
  }, [p.filename, p.editable])

  useEffect(() => {
    const model = ed.current?.editor.getModel()
    if (!model || model.getValue(undefined, true) === p.text || model.getAlternativeVersionId() !== base.current.version) return
    base.current.applying = true
    model.setValue(p.text)
    base.current.applying = false
    base.current.version = model.getAlternativeVersionId()
    p.onDirty(false)
  }, [p.text])

  useEffect(() => {
    ed.current?.editor.updateOptions({ wordWrap: p.wrap ? 'on' : 'off' })
    ed.current?.setLook(p.look)
  }, [p.wrap, p.look])

  return (
    <div class="diff-editor file">
      <div class="mo-host" ref={host} />
    </div>
  )
}
