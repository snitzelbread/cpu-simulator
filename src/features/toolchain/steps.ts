/** How many steps each stage view has (the views decide what a step shows). */
import type { BuildResult, UnitResult } from '../../toolchain/pipeline'
import type { Pass, StageId } from './store'

export function unitOf(b: BuildResult, unit: string): UnitResult | undefined {
  return b.units.find((u) => u.file === unit) ?? b.units[0]
}

/** Lines of the .s file that produce bytes, in order (the assembler view steps through them). */
export function asmByteLines(u: UnitResult | undefined): number[] {
  if (!u?.obj) return []
  const lines = new Set<number>()
  for (const ins of u.obj.instructions) lines.add(ins.line)
  for (const d of u.obj.dataItems) lines.add(d.line)
  return [...lines].sort((a, b) => a - b)
}

export function pass2Lines(u: UnitResult | undefined): number[] {
  if (!u) return []
  return u.pp.pass2.map((l, i) => (l.length ? i + 1 : 0)).filter(Boolean)
}

export function stepCount(b: BuildResult, stage: StageId, pass: Pass, unit: string): number {
  const u = unitOf(b, unit)
  switch (stage) {
    case 'pp':
      if (!u) return 0
      return pass === 1 ? u.pp.pass1.changes.length : pass === 2 ? pass2Lines(u).length : u.pp.steps.length
    case 'cc':
      return u?.cc && !u.cc.errors.length ? u.cc.steps.length : 0
    case 'as':
      return asmByteLines(u).length
    case 'ld':
      return b.ld?.steps.length ?? 0
  }
}

/** Index of the current step: the last one when finished. */
export function currentIndex(pos: number | null, n: number): number {
  return pos === null ? n - 1 : pos - 1
}
