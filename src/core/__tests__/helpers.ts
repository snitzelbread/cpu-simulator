import { assemble } from '../assembler'
import { Machine } from '../cpu/machine'
import { lookupRegister } from '../registers'

export function load(src: string): Machine {
  const r = assemble(src)
  if (r.errors.length) throw new Error('assembly failed: ' + JSON.stringify(r.errors))
  return new Machine(r.program!)
}

/** Assemble and run until the program stops (hlt is appended). */
export function run(src: string, limit = 10_000): Machine {
  const m = load(src + '\nsection .text\nhlt')
  m.run({ limit })
  return m
}

export function reg(m: Machine, name: string): bigint {
  return m.readReg(lookupRegister(name)!)
}

export function flagStr(m: Machine): string {
  return (['CF', 'PF', 'ZF', 'SF', 'OF'] as const).map((f) => `${f}=${m.flags[f] ? 1 : 0}`).join(' ')
}
