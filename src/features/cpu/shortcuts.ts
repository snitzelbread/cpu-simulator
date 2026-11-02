import { useEffect } from 'react'
import { useCpu } from './store'

export interface Shortcut {
  key: string
  shift?: boolean
  ctrl?: boolean
  label: string
}

export const SHORTCUTS = {
  step: { key: 'F10', label: 'F10' },
  stepBack: { key: 'F10', shift: true, label: 'Shift+F10' },
  stepOver: { key: 'F8', label: 'F8' },
  run: { key: 'F5', label: 'F5' },
  reset: { key: 'F5', shift: true, label: 'Shift+F5' },
  runToCursor: { key: 'F10', ctrl: true, label: 'Ctrl+F10' },
  micro: { key: 'm', ctrl: true, shift: true, label: 'Ctrl+Shift+M' },
} satisfies Record<string, Shortcut>

function matches(e: KeyboardEvent, s: Shortcut) {
  return e.key.toLowerCase() === s.key.toLowerCase() && !!s.shift === e.shiftKey && !!s.ctrl === (e.ctrlKey || e.metaKey)
}

/**
 * Global debugger shortcuts. Registered in the capture phase so they also work
 * while the editor has focus, and F5 never reloads the page (which would lose code).
 */
export function useShortcuts(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const st = useCpu.getState()
      const actions: [Shortcut, () => void][] = [
        [SHORTCUTS.stepBack, st.stepBack],
        [SHORTCUTS.runToCursor, st.runToCursor],
        [SHORTCUTS.step, st.step],
        [SHORTCUTS.stepOver, st.stepOver],
        [SHORTCUTS.reset, st.reset],
        [SHORTCUTS.run, st.toggleRun],
        [SHORTCUTS.micro, () => st.setMicroMode(!st.microMode)],
      ]
      for (const [s, fn] of actions) {
        if (matches(e, s)) {
          e.preventDefault()
          e.stopPropagation()
          fn()
          return
        }
      }
      // never let F5 reload the page
      if (e.key === 'F5') e.preventDefault()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [enabled])
}
