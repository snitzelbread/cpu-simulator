import { create } from 'zustand'

export type NumberFormat = 'hex' | 'udec' | 'sdec' | 'bin'
export type Theme = 'dark' | 'light'
export type Mode = 'cpu' | 'toolchain'

interface Settings {
  theme: Theme
  format: NumberFormat
  animations: boolean
  mode: Mode
  showBytes: boolean
  set: (p: Partial<Omit<Settings, 'set'>>) => void
}

const KEY = 'cpusim.settings'
const prefersReduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
const prefersLight = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches

function loadSaved(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

/** UI preferences shared by all modes; persisted in localStorage. */
export const useSettings = create<Settings>((set, get) => ({
  theme: prefersLight ? 'light' : 'dark',
  format: 'hex',
  animations: !prefersReduced,
  mode: 'cpu',
  showBytes: false,
  ...loadSaved(),
  set: (p) => {
    set(p)
    const { theme, format, animations, mode, showBytes } = get()
    localStorage.setItem(KEY, JSON.stringify({ theme, format, animations, mode, showBytes }))
  },
}))
