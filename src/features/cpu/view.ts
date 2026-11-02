import { useMemo } from 'react'
import type { Program } from '../../core/assembler'
import type { Machine } from '../../core/cpu/machine'
import type { Flags, StepTrace } from '../../core/cpu/state'
import type { Instruction } from '../../core/types'
import { useCpu, type MicroPhase } from './store'

/**
 * What the panels display at the current moment. In micro-step mode the
 * Execute phase (2) still shows the old register values; Write-back (3) shows the new ones.
 */
export interface View {
  machine: Machine | null
  program: Program | null
  /** The step whose effects are highlighted (null: nothing to highlight) */
  trace: StepTrace | null
  /** The most recent step (also during micro phases 0/1) */
  lastTrace: StepTrace | null
  regs: bigint[]
  flags: Flags
  rip: number
  phase: MicroPhase
  /** Instruction that executes next (or is being executed in micro phases) */
  next: Instruction | undefined
  changedRegs: Set<number>
  /** Values before the highlighted step, by register index */
  prevRegs: Map<number, bigint>
  version: number
}

export function useView(): View {
  const machine = useCpu((s) => s.machine)
  const version = useCpu((s) => s.version)
  const phase = useCpu((s) => s.microPhase)
  return useMemo(() => {
    const empty: View = {
      machine: null, program: null, trace: null, lastTrace: null, regs: new Array(16).fill(0n),
      flags: { CF: false, PF: false, ZF: false, SF: false, OF: false }, rip: 0, phase, next: undefined,
      changedRegs: new Set(), prevRegs: new Map(), version,
    }
    if (!machine) return empty
    const last = machine.history.at(-1) ?? null
    let trace: StepTrace | null = last
    let regs = [...machine.regs]
    let flags = { ...machine.flags }
    let rip = machine.rip
    // once the program has ended nothing executes next
    let next = machine.done ? undefined : machine.current
    if (phase === 0 || phase === 1) {
      trace = null
      if (phase === 1 && next) rip = next.address + next.length
    } else if (phase === 2 && last) {
      // executing: the ALU has the result, registers are not written yet
      for (let i = last.regs.length - 1; i >= 0; i--) regs[last.regs[i].index] = last.regs[i].before
      flags = { ...last.flagsBefore }
      rip = last.instr.address + last.instr.length
      next = last.instr
    } else if (phase === 3 && last) {
      next = last.instr
    }
    const changedRegs = new Set<number>()
    const prevRegs = new Map<number, bigint>()
    if (trace && phase !== 2) {
      for (const r of trace.regs) if (!prevRegs.has(r.index)) prevRegs.set(r.index, r.before)
      for (const [i, before] of prevRegs) if (machine.regs[i] !== before) changedRegs.add(i)
    }
    if (phase !== 2) regs = [...machine.regs]
    return { machine, program: machine.program, trace, lastTrace: last, regs, flags, rip, phase, next, changedRegs, prevRegs, version }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, version, phase])
}
