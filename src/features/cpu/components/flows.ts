import type { StepTrace } from '../../../core/cpu/state'
import type { Operand } from '../../../core/types'

export interface Flow {
  from: string
  to: string
  /** data: value transfer, mem: to/from memory, ctrl: control (flags/RIP) */
  kind: 'data' | 'mem' | 'ctrl'
  /** 0 = operands into the ALU, 1 = result out */
  stage: 0 | 1
}

const reg = (i: number) => `reg-${i}`

/** Derive the data paths of a step for the CPU diagram. */
export function computeFlows(tr: StepTrace): Flow[] {
  const out: Flow[] = []
  const ins = tr.instr
  const [d, s, x] = ins.operands
  const add = (from: string | null, to: string, kind: Flow['kind'] = 'data', stage: 0 | 1 = 0) => {
    if (from && from !== to && !out.some((f) => f.from === from && f.to === to)) out.push({ from, to, kind, stage })
  }
  const src = (o: Operand | undefined): string | null => (!o ? null : o.k === 'reg' ? reg(o.reg.index) : o.k === 'mem' ? 'bus' : 'ir')
  const kindOf = (o: Operand | undefined): Flow['kind'] => (o?.k === 'mem' ? 'mem' : 'data')
  const memWrite = tr.mem.some((m) => m.kind === 'write')
  const regDests = [...new Set(tr.regs.map((r) => r.index))]
  const stackOp = ['push', 'pop', 'call', 'ret'].includes(ins.op)

  // address registers of memory operands → bus
  if (ins.op !== 'lea')
    for (const o of ins.operands)
      if (o.k === 'mem') for (const r of [o.base, o.index]) if (r) add(reg(r.index), 'bus', 'mem')

  if (tr.alu) {
    let a: string | null = src(d)
    let b: string | null = src(s)
    let ka = kindOf(d)
    let kb = kindOf(s)
    if ((ins.op === 'mul' || ins.op === 'imul') && ins.operands.length === 1) {
      a = reg(0); ka = 'data'; b = src(d); kb = kindOf(d)
    } else if (ins.op === 'div' || ins.op === 'idiv') {
      a = reg(0); ka = 'data'; b = src(d); kb = kindOf(d)
      add(reg(2), 'alu-a')
    } else if (ins.op === 'imul' && x) {
      a = src(s); ka = kindOf(s); b = 'ir'; kb = 'data'
    } else if (['inc', 'dec', 'neg', 'not'].includes(ins.op)) {
      b = ins.op === 'inc' || ins.op === 'dec' ? 'ir' : null
    }
    add(a, 'alu-a', ka)
    add(b, 'alu-b', kb)
    for (const i of regDests) add('alu-out', reg(i), 'data', 1)
    if (memWrite) add('alu-out', 'bus', 'mem', 1)
    if (tr.flagsAffected.length) add('alu-out', 'flags', 'ctrl', 1)
    return out
  }

  switch (ins.op) {
    case 'mov':
    case 'movzx':
    case 'movsx':
    case 'movsxd':
      for (const i of regDests) add(src(s), reg(i), kindOf(s), 1)
      if (memWrite) add(src(s), 'bus', 'mem', 1)
      break
    case 'cbw':
    case 'cwde':
    case 'cdqe':
    case 'cwd':
    case 'cdq':
    case 'cqo':
      for (const i of regDests) add(reg(0), reg(i), 'data', 1)
      break
    case 'lea':
      if (s.k === 'mem') for (const r of [s.base, s.index]) if (r) add(reg(r.index), reg(regDests[0]), 'data', 1)
      if (s.k === 'mem' && !s.base && !s.index) add('ir', reg(regDests[0]), 'data', 1)
      break
    case 'xchg':
      add(src(d), src(s)!, kindOf(s), 1)
      add(src(s), src(d)!, kindOf(d), 1)
      break
    case 'push':
      add(src(d), 'bus', 'mem', 1)
      break
    case 'pop':
      add('bus', src(d)!, 'mem', 1)
      break
    case 'call':
      add('rip', 'bus', 'mem', 1)
      add(src(d), 'rip', 'ctrl', 1)
      break
    case 'ret':
      add('bus', 'rip', 'mem', 1)
      break
    case 'jmp':
      add(src(d), 'rip', 'ctrl', 1)
      break
    case 'jcc':
    case 'loop':
      add(ins.op === 'loop' ? reg(1) : 'flags', 'rip', 'ctrl', 0)
      if (tr.branch?.taken) add('ir', 'rip', 'ctrl', 1)
      break
    case 'setcc':
      add('flags', src(d)!, 'ctrl', 1)
      break
    case 'cmovcc':
      add('flags', reg(regDests[0] ?? (d.k === 'reg' ? d.reg.index : 0)), 'ctrl', 0)
      if (tr.branch?.taken) add(src(s), src(d)!, kindOf(s), 1)
      break
    case 'syscall':
      add('rip', reg(1), 'data', 1)
      add('flags', reg(11), 'data', 1)
      if (tr.syscall?.bytes) add(reg(6), 'bus', 'mem', 0)
      break
  }
  if (stackOp) add(reg(4), 'bus', 'mem', 0)
  return out
}
