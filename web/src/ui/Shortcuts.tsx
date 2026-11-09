const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'

export const SHORTCUTS: [string, string][] = [
  [`${MOD} ⇧ P`, 'Command palette'],
  [`${MOD} F`, 'Search commits'],
  [`${MOD} ⇧ A`, 'Search projects'],
  [MOD === '⌘' ? '⌥ ↑ ↓' : 'Alt ↑ ↓', 'Move a project in the sidebar'],
  [`${MOD} B`, 'New branch from HEAD'],
  [`${MOD} L`, 'Fetch every remote'],
  [`${MOD} ⏎`, 'Commit'],
  [`${MOD} ⇧ S`, 'Stage everything'],
  [`${MOD} ⇧ U`, 'Unstage everything'],
  [`${MOD} S`, 'Save edits in the diff'],
  ['↑ ↓  or  K J', 'Move through commits'],
  [`${MOD} J`, 'Toggle the left panel'],
  [MOD === '⌘' ? '⌃ `' : 'Ctrl `', 'Show your agent, or go back from it'],
  ['?', 'This list'],
  ['Esc', 'Close dialogs, clear the search'],
]

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="dialog">
        <h3>Keyboard shortcuts</h3>
        <div class="keys">
          {SHORTCUTS.map(([k, d]) => (
            <div class="key-row" key={k}>
              <kbd>{k}</kbd>
              <span>{d}</span>
            </div>
          ))}
        </div>
        <div class="buttons">
          <button class="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
