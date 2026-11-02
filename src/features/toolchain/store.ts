/**
 * Session state of the C toolchain view: the virtual project, the build result of all
 * four stages, which stage/pass/unit is shown, and the step position inside it.
 */
import { create } from 'zustand'
import { useSettings } from '../../app/settings'
import { TOOLCHAIN_EXAMPLES } from '../../toolchain/examples'
import { build, type BuildResult } from '../../toolchain/pipeline'
import { isSourceFile, validFileName, type SourceFile } from '../../toolchain/project'
import { useCpu } from '../cpu/store'
import { stepCount } from './steps'

export type StageId = 'pp' | 'cc' | 'as' | 'ld'
export type Pass = 1 | 2 | 3

/** A highlighted place: a C line or a line of the generated assembly of the selected unit. */
export type Focus = { kind: 'c'; file: string; line: number } | { kind: 'asm'; line: number } | null

interface TcState {
  files: SourceFile[]
  activeFile: string
  build: BuildResult
  stage: StageId
  pass: Pass
  /** Selected translation unit (.c file) for the per-unit stages. */
  unit: string
  /** Step position: 0 = start, null = finished (everything shown). */
  pos: number | null
  playing: boolean
  hover: Focus
  pinned: Focus
  speed: number

  setText(name: string, text: string): void
  setActiveFile(name: string): void
  addFile(name: string): string | null
  renameFile(from: string, to: string): string | null
  deleteFile(name: string): void
  loadExample(id: string): void
  setStage(s: StageId): void
  setPass(p: Pass): void
  setUnit(u: string): void
  setHover(f: Focus): void
  setPinned(f: Focus): void
  step(): void
  stepBack(): void
  reset(): void
  toEnd(): void
  togglePlay(): void
  runInCpu(): void
}

const PROJECT_KEY = 'cpusim.project'

function initialFiles(): SourceFile[] {
  try {
    const raw = localStorage.getItem(PROJECT_KEY)
    if (raw) {
      const files = JSON.parse(raw) as SourceFile[]
      if (Array.isArray(files) && files.length && files.every((f) => typeof f.name === 'string' && typeof f.text === 'string')) return files
    }
  } catch {
    /* ignore */
  }
  return TOOLCHAIN_EXAMPLES.find((e) => e.id === 'two-units')!.files.map((f) => ({ ...f }))
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
let playTimer: ReturnType<typeof setInterval> | undefined

function firstUnit(files: SourceFile[], prefer?: string): string {
  const units = files.filter((f) => isSourceFile(f.name)).map((f) => f.name)
  if (prefer && units.includes(prefer)) return prefer
  return units.includes('main.c') ? 'main.c' : (units[0] ?? '')
}

export const useToolchain = create<TcState>((set, get) => {
  const files0 = initialFiles()

  const rebuild = (files: SourceFile[], extra: Partial<TcState> = {}) => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => localStorage.setItem(PROJECT_KEY, JSON.stringify(files)), 300)
    const unit = firstUnit(files, extra.unit ?? get().unit)
    stopPlay()
    set({ files, build: build({ files }), unit, pos: null, playing: false, ...extra })
  }

  const stopPlay = () => {
    clearInterval(playTimer)
    playTimer = undefined
  }

  const count = () => {
    const s = get()
    return stepCount(s.build, s.stage, s.pass, s.unit)
  }

  return {
    files: files0,
    activeFile: firstUnit(files0),
    build: build({ files: files0 }),
    stage: 'pp',
    pass: 3,
    unit: firstUnit(files0),
    pos: null,
    playing: false,
    hover: null,
    pinned: null,
    speed: 2,

    setText(name, text) {
      const files = get().files.map((f) => (f.name === name ? { ...f, text } : f))
      rebuild(files)
    },

    setActiveFile(name) {
      const extra: Partial<TcState> = { activeFile: name }
      if (isSourceFile(name)) extra.unit = name
      set(extra)
      if (extra.unit) set({ pos: null })
    },

    addFile(name) {
      const { files } = get()
      if (!validFileName(name)) return 'invalidName'
      if (files.some((f) => f.name === name)) return 'exists'
      const text = name.endsWith('.h') ? `#ifndef ${guard(name)}\n#define ${guard(name)}\n\n#endif\n` : `#include <stdio.h>\n\n`
      rebuild([...files, { name, text }], { activeFile: name })
      return null
    },

    renameFile(from, to) {
      const { files } = get()
      if (from === to) return null
      if (!validFileName(to)) return 'invalidName'
      if (files.some((f) => f.name === to)) return 'exists'
      rebuild(files.map((f) => (f.name === from ? { ...f, name: to } : f)), { activeFile: to })
      return null
    },

    deleteFile(name) {
      const files = get().files.filter((f) => f.name !== name)
      if (!files.length) return
      rebuild(files, { activeFile: firstUnit(files) || files[0].name })
    },

    loadExample(id) {
      const ex = TOOLCHAIN_EXAMPLES.find((e) => e.id === id)
      if (!ex) return
      const files = ex.files.map((f) => ({ ...f }))
      const unit = firstUnit(files)
      rebuild(files, { activeFile: unit, unit, stage: ex.stage, pass: 3, hover: null, pinned: null })
    },

    setStage(stage) {
      stopPlay()
      set({ stage, pos: null, playing: false, hover: null, pinned: null })
    },
    setPass(pass) {
      stopPlay()
      set({ pass, pos: null, playing: false })
    },
    setUnit(unit) {
      stopPlay()
      set({ unit, activeFile: unit, pos: null, playing: false, hover: null, pinned: null })
    },
    setHover(hover) {
      set({ hover })
    },
    setPinned(pinned) {
      const cur = get().pinned
      set({ pinned: cur && pinned && JSON.stringify(cur) === JSON.stringify(pinned) ? null : pinned })
    },

    step() {
      const n = count()
      const { pos } = get()
      if (n === 0) return
      // from the finished view, stepping starts again at the first step
      const next = pos === null ? 1 : pos + 1
      set({ pos: next >= n ? null : next })
      if (next >= n) {
        stopPlay()
        set({ playing: false })
      }
    },
    stepBack() {
      const n = count()
      const { pos } = get()
      stopPlay()
      if (pos === 0 || n === 0) return set({ playing: false })
      set({ pos: pos === null ? n - 1 : pos - 1, playing: false })
    },
    reset() {
      stopPlay()
      set({ pos: count() ? 0 : null, playing: false })
    },
    toEnd() {
      stopPlay()
      set({ pos: null, playing: false })
    },
    togglePlay() {
      if (get().playing) {
        stopPlay()
        return set({ playing: false })
      }
      if (!count()) return
      if (get().pos === null) set({ pos: 0 })
      set({ playing: true })
      playTimer = setInterval(() => {
        if (!get().playing) return stopPlay()
        get().step()
      }, 700)
    },

    runInCpu() {
      const b = get().build
      const ld = b.ld
      if (!ld?.program) return
      const lines = ld.listing.split('\n')
      const cLines = lines.map((_, i) => b.cLocation(i + 1))
      useCpu.getState().loadLinked({ listing: ld.listing, program: ld.program, cLines, cFiles: get().files.map((f) => ({ ...f })) })
      useSettings.getState().set({ mode: 'cpu' })
    },
  }
})

function guard(name: string) {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}
