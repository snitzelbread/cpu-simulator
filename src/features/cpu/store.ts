/**
 * Session state of the CPU view. The Machine itself is mutable and lives outside
 * React; components subscribe to `version`, which is bumped after every change.
 */
import { create } from 'zustand'
import { assemble, type AssembleResult, type Program } from '../../core/assembler'
import { Machine } from '../../core/cpu/machine'
import { EXAMPLES } from '../../examples'

/** Steps per press of Run / Step over / Run to cursor before we stop and ask. */
export const RUN_LIMIT = 100_000
export const SPEEDS = [1, 2, 4, 8, 16, 50, 200, 1000]

export type MicroPhase = 0 | 1 | 2 | 3 | null

export type Notice = { kind: 'stepLimit'; steps: number } | { kind: 'reset' } | null

/** A program built by the C toolchain (linked image + listing + C line mapping). */
export interface LinkedProgram {
  listing: string
  program: Program
  /** C source location for each listing line (index = line - 1). */
  cLines: ({ file: string; line: number } | null)[]
  /** C source files, for showing the current C line. */
  cFiles: { name: string; text: string }[]
}

interface CpuState {
  source: string
  asm: AssembleResult
  machine: Machine | null
  version: number
  /** Source lines with a breakpoint */
  breakpoints: number[]
  running: boolean
  notice: Notice
  microMode: boolean
  microPhase: MicroPhase
  speedIndex: number
  cursorLine: number
  /** Set while the CPU runs a program from the C toolchain (the editor is read-only). */
  linked: LinkedProgram | null
  /** The user's own assembly, kept while a linked program is shown. */
  savedSource: string | null

  setSource(src: string): void
  loadExample(id: string): void
  setBreakpoints(lines: number[]): void
  setCursorLine(line: number): void
  step(): void
  stepBack(): void
  stepOver(): void
  run(): void
  pause(): void
  toggleRun(): void
  reset(): void
  runToCursor(): void
  setMicroMode(on: boolean): void
  setSpeedIndex(i: number): void
  dismissNotice(): void
  loadLinked(p: LinkedProgram): void
  /** Leave the linked program: 'edit' keeps the listing as editable assembly, 'restore' brings back the user's own source. */
  unlink(how: 'edit' | 'restore'): void
}

const SOURCE_KEY = 'cpusim.source'

function initialSource(): string {
  try {
    const s = localStorage.getItem(SOURCE_KEY)
    if (s && s.trim()) return s
  } catch {
    /* ignore */
  }
  return EXAMPLES[0].source
}

function build(source: string) {
  const asm = assemble(source)
  return { asm, machine: asm.program ? new Machine(asm.program) : null }
}

let rafHandle = 0
let saveTimer: ReturnType<typeof setTimeout> | undefined

export const useCpu = create<CpuState>((set, get) => {
  const bump = (extra: Partial<CpuState> = {}) => set((s) => ({ version: s.version + 1, ...extra }))

  const bpAddresses = (): Set<number> => {
    const { asm, breakpoints } = get()
    const out = new Set<number>()
    for (const line of breakpoints) {
      if (asm.sourceMap.lineToInstr.has(line)) out.add(asm.sourceMap.lineToAddress.get(line)!)
    }
    return out
  }

  const stopLoop = () => {
    cancelAnimationFrame(rafHandle)
    rafHandle = 0
  }

  const src = initialSource()
  return {
    source: src,
    ...build(src),
    version: 0,
    breakpoints: [],
    running: false,
    notice: null,
    microMode: false,
    microPhase: null,
    speedIndex: 3,
    cursorLine: 1,
    linked: null,
    savedSource: null,

    setSource(source) {
      if (source === get().source || get().linked) return
      stopLoop()
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => localStorage.setItem(SOURCE_KEY, source), 300)
      const hadHistory = !!get().machine?.history.length
      bump({ source, ...build(source), running: false, microPhase: null, notice: hadHistory ? { kind: 'reset' } : null })
    },

    loadExample(id) {
      const ex = EXAMPLES.find((e) => e.id === id)
      if (!ex) return
      set({ linked: null, savedSource: null })
      get().setSource(ex.source)
      set({ breakpoints: [], notice: null })
    },

    setBreakpoints(lines) {
      set({ breakpoints: lines })
    },

    setCursorLine(line) {
      set({ cursorLine: line })
    },

    step() {
      const { machine, microMode, microPhase, running } = get()
      if (!machine || running) return
      if (microMode) {
        if (machine.done && (microPhase === null || microPhase === 3)) return
        if (microPhase === null || microPhase === 3) return bump({ microPhase: 0, notice: null })
        if (microPhase === 0) return bump({ microPhase: 1 })
        if (microPhase === 1) {
          machine.step()
          return bump({ microPhase: 2 })
        }
        return bump({ microPhase: 3 })
      }
      if (machine.done) return
      machine.step()
      bump({ notice: null, microPhase: null })
    },

    stepBack() {
      const { machine, microMode, microPhase, running } = get()
      if (!machine || running) return
      if (microMode && microPhase !== null) {
        if (microPhase === 3) return bump({ microPhase: 2 })
        if (microPhase === 2) {
          machine.stepBack()
          return bump({ microPhase: 1 })
        }
        return bump({ microPhase: microPhase === 1 ? 0 : null })
      }
      if (!machine.canStepBack()) return
      machine.stepBack()
      bump({ notice: null, microPhase: null })
    },

    stepOver() {
      const { machine, running } = get()
      if (!machine || running || machine.done) return
      const r = machine.stepOver({ limit: RUN_LIMIT, breakpoints: bpAddresses() })
      bump({ microPhase: null, notice: r.reason === 'limit' ? { kind: 'stepLimit', steps: r.steps } : null })
    },

    runToCursor() {
      const { machine, running, asm, cursorLine } = get()
      if (!machine || running || machine.done) return
      // the first instruction at or after the cursor line
      const lines = [...asm.sourceMap.lineToInstr.keys()].sort((a, b) => a - b)
      const line = lines.find((l) => l >= cursorLine)
      if (line === undefined) return
      const target = asm.sourceMap.lineToAddress.get(line)!
      let steps = 0
      if (machine.rip === target) {
        machine.step()
        steps = 1
      }
      const r = machine.run({ limit: RUN_LIMIT - steps, breakpoints: bpAddresses(), stop: (m) => m.rip === target })
      bump({ microPhase: null, notice: r.reason === 'limit' ? { kind: 'stepLimit', steps: r.steps + steps } : null })
    },

    run() {
      const { machine, running } = get()
      if (!machine || running || machine.done) return
      const bps = bpAddresses()
      let total = 0
      let budget = 1 // execute the first step immediately
      let last = performance.now()
      let first = true
      set({ running: true, notice: null, microPhase: null })
      const frame = (now: number) => {
        const st = get()
        const m = st.machine
        if (!st.running || m !== machine) return
        const speed = SPEEDS[st.speedIndex]
        let n: number
        if (speed >= 1000) n = 4000
        else {
          budget += ((now - last) / 1000) * speed
          n = Math.floor(budget)
          budget -= n
        }
        last = now
        if (n > 0) {
          const r = m.run({ limit: Math.min(n, RUN_LIMIT - total), breakpoints: bps, skipFirstBreakpoint: first })
          first = false
          total += r.steps
          if (r.reason === 'breakpoint' || r.reason === 'stopped') {
            stopLoop()
            return bump({ running: false })
          }
          if (total >= RUN_LIMIT) {
            stopLoop()
            return bump({ running: false, notice: { kind: 'stepLimit', steps: total } })
          }
          bump()
        }
        rafHandle = requestAnimationFrame(frame)
      }
      rafHandle = requestAnimationFrame(frame)
      frame(performance.now())
    },

    pause() {
      stopLoop()
      if (get().running) bump({ running: false })
    },

    toggleRun() {
      if (get().running) get().pause()
      else get().run()
    },

    reset() {
      stopLoop()
      const { asm } = get()
      bump({ machine: asm.program ? new Machine(asm.program) : null, running: false, microPhase: null, notice: null })
    },

    setMicroMode(on) {
      // Leaving micro mode mid-instruction is safe: in phases 0/1 the step has not run yet,
      // in phases 2/3 it has already been executed completely.
      bump({ microMode: on, microPhase: null })
    },

    setSpeedIndex(i) {
      set({ speedIndex: i })
    },

    dismissNotice() {
      set({ notice: null })
    },

    loadLinked(p) {
      stopLoop()
      const st = get()
      const asm: AssembleResult = { program: p.program, symbols: p.program.symbols, sourceMap: p.program.sourceMap, errors: [] }
      bump({
        linked: p,
        savedSource: st.linked ? st.savedSource : st.source,
        source: p.listing,
        asm,
        machine: new Machine(p.program),
        breakpoints: [],
        running: false,
        microPhase: null,
        notice: null,
      })
    },

    unlink(how) {
      const { savedSource, source } = get()
      if (how === 'restore') {
        set({ linked: null, savedSource: null })
        if (savedSource !== null) get().setSource(savedSource)
      } else {
        // keep savedSource: "My program" stays available until the user restores it or loads an example
        set({ linked: null })
        // the listing becomes normal, editable assembly (assembled again from its text)
        localStorage.setItem(SOURCE_KEY, source)
        bump({ ...build(source), running: false, microPhase: null })
      }
    },
  }
})
