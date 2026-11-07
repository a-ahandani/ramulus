export function Splitter({ onDrag, onEnd, horizontal }: { onDrag: (delta: number) => void; onEnd?: () => void; horizontal?: boolean }) {
  return (
    <div
      class={`splitter ${horizontal ? 'horizontal' : ''}`}
      onPointerDown={(e) => {
        e.preventDefault()
        const at = (ev: PointerEvent) => (horizontal ? ev.clientY : ev.clientX)
        let last = at(e)
        const move = (ev: PointerEvent) => {
          onDrag(at(ev) - last)
          last = at(ev)
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          document.body.style.cursor = ''
          onEnd?.()
        }
        document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize'
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    />
  )
}
