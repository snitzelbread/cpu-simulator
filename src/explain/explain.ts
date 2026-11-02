/**
 * Turns a StepTrace into plain-language sentences (via the i18n table).
 * Kept outside src/core so the emulator stays language-neutral.
 */
import type { Program } from '../core/assembler'
import type { FlagName, StepTrace } from '../core/cpu/state'
import { regName } from '../core/registers'
import { symbolize } from '../core/symbols'
import type { MemOperand, Operand } from '../core/types'
import { hex, msb, toSigned, trunc, type Size } from '../core/util'
import { formatFault, t } from '../i18n'

export interface FlagNote {
  flag: FlagName
  before: boolean
  after: boolean
  reason: string
  undefined?: boolean
}

export interface Explanation {
  summary: string
  notes: string[]
  flags: FlagNote[]
  fault?: string
}

const MINUS = '−'

/** Small values as (signed) decimal, large ones as hex. */
export function fmt(v: bigint, size: Size = 8): string {
  const s = toSigned(v, size)
  if (s > -65536n && s < 65536n) return s < 0n ? MINUS + (-s).toString() : s.toString()
  return hex(trunc(v, size))
}

/** Unsigned decimal for small values, hex otherwise. */
export function fmtU(v: bigint, size: Size = 8): string {
  const u = trunc(v, size)
  return u < 65536n ? u.toString() : hex(u)
}

export function addr(a: number | bigint, program?: Program): string {
  const h = hex(a)
  const sym = program ? symbolize(program, Number(a)) : undefined
  return sym ? `${h} (${sym})` : h
}

function regUpper(name: string) {
  return name.toUpperCase()
}

/** How an operand is named in a sentence. */
function opName(o: Operand, tr: StepTrace): string {
  if (o.k === 'reg') return regUpper(o.reg.name)
  if (o.k === 'imm') return fmt(o.value, tr.instr.opSize ?? 8)
  return `[${hex(tr.ea ?? 0n)}]`
}

function eaExpr(m: MemOperand): string {
  const parts: string[] = []
  if (m.base) parts.push(regUpper(m.base.name))
  if (m.index) parts.push(m.scale === 1 ? regUpper(m.index.name) : `${regUpper(m.index.name)}·${m.scale}`)
  if (m.disp !== 0n || !parts.length) parts.push(m.disp < 0n && parts.length ? `${MINUS} ${hex(-m.disp)}` : hex(m.disp))
  return parts.join(' + ').replace(`+ ${MINUS}`, MINUS)
}

function ones(v: bigint): number {
  let n = 0
  let b = Number(v & 0xffn)
  while (b) {
    n += b & 1
    b >>= 1
  }
  return n
}

type Category = 'add' | 'sub' | 'neg' | 'logic' | 'shift' | 'rotate' | 'mul' | 'none'

function category(op: string): Category {
  if (['add', 'adc', 'inc'].includes(op)) return 'add'
  if (['sub', 'sbb', 'cmp', 'dec'].includes(op)) return 'sub'
  if (op === 'neg') return 'neg'
  if (['and', 'or', 'xor', 'test'].includes(op)) return 'logic'
  if (['shl', 'sal', 'shr', 'sar'].includes(op)) return 'shift'
  if (['rol', 'ror'].includes(op)) return 'rotate'
  if (['mul', 'imul'].includes(op)) return 'mul'
  return 'none'
}

function flagNotes(tr: StepTrace): FlagNote[] {
  const S = t().explain.flagReason
  const cat = category(tr.instr.op)
  const alu = tr.alu
  const size = alu?.size ?? 8
  return tr.flagsAffected.map((flag) => {
    const before = tr.flagsBefore[flag]
    const after = tr.flagsAfter[flag]
    if (tr.flagsUndefined.includes(flag)) return { flag, before, after, reason: t().flagUndefined, undefined: true }
    let reason = ''
    const v = after
    switch (flag) {
      case 'ZF': reason = S.ZF(v); break
      case 'SF': reason = S.SF(v); break
      case 'PF': reason = S.PF(v, ones(alu?.result ?? 0n)); break
      case 'CF':
        reason = cat === 'add' ? S.CFadd(v)
          : cat === 'sub' ? S.CFsub(v, fmtU(alu!.a, size), fmtU(alu!.b! + (alu!.carryIn ? 1n : 0n), size))
          : cat === 'logic' ? S.CFlogic
          : cat === 'shift' || cat === 'rotate' ? S.CFshift(v)
          : cat === 'neg' ? S.CFneg(v)
          : S.CFmul(v)
        break
      case 'OF':
        reason = cat === 'add' ? S.OFadd(v)
          : cat === 'sub' ? S.OFsub(v)
          : cat === 'logic' ? S.OFlogic
          : cat === 'shift' || cat === 'rotate' ? S.OFshift(v)
          : cat === 'neg' ? S.OFneg(v)
          : S.OFmul(v)
        break
    }
    return { flag, before, after, reason }
  })
}

function condValues(formula: string, tr: StepTrace): string {
  const f = tr.flagsBefore
  return formula.replace(/(CF|ZF|SF|OF|PF)( = [01])?/g, (_m, name: FlagName, eq?: string) =>
    eq ? `${name} = ${f[name] ? 1 : 0}` : `${f[name] ? 1 : 0}`,
  )
}

function regNotes(tr: StepTrace, skip: Set<number>): string[] {
  const E = t().explain
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of tr.regs) {
    if (skip.has(r.index)) continue
    const key = r.name
    if (seen.has(key)) continue
    seen.add(key)
    const r64 = regUpper(regName(r.index, 8))
    if (r.zeroExtended) out.push(E.zeroExtend(r64))
    else if (r.size < 8) out.push(E.partialWrite(r.size * 8, r64, 64 - r.size * 8))
  }
  return out
}

function memNotes(tr: StepTrace): string[] {
  const E = t().explain
  return tr.mem
    .filter((m) => !m.fetch)
    .map((m) => (m.kind === 'read' ? E.memRead(m.size, hex(m.address)) : E.memWrite(m.size, hex(m.address))))
}

function bytesText(bytes: number[]): string {
  const s = new TextDecoder().decode(new Uint8Array(bytes))
  return '"' + s.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'
}

export function explain(tr: StepTrace, program: Program): Explanation {
  const E = t().explain
  const ins = tr.instr
  const text = ins.text
  const [d, s, third] = ins.operands
  const size = (ins.opSize ?? 8) as Size
  const alu = tr.alu
  const notes: string[] = []
  let summary = ''
  const skipRegs = new Set<number>()

  if (tr.fault) {
    return { summary: E.fault(text), notes: [], flags: [], fault: formatFault(tr.fault) }
  }

  const written = (i = 0) => tr.regs[i]
  const opSym: Record<string, string> = { '+': '+', '-': MINUS, '&': 'AND', '|': 'OR', '^': 'XOR', test: 'AND' }
  const target = (a: number) => addr(a, program)

  switch (ins.op) {
    case 'mov': {
      const v = d.k === 'reg' ? trunc(written()!.after >> (d.reg.high8 ? 8n : 0n), size) : tr.mem.find((m) => m.kind === 'write')!.value
      summary = E.mov(text, opName(d, tr), fmt(v, size))
      break
    }
    case 'movzx':
    case 'movsx':
    case 'movsxd': {
      const after = trunc(written()!.after, size)
      const value = fmt(after, size)
      if (ins.op === 'movzx') summary = E.movzx(text, opName(d, tr), value)
      else summary = E.movsx(text, opName(d, tr), value, msb(after, size) ? '1' : '0')
      break
    }
    case 'lea': {
      const v = hex(tr.ea ?? 0n)
      summary = E.lea(text, eaExpr(s as MemOperand), v, opName(d, tr))
      break
    }
    case 'xchg':
      summary = E.xchg(text, opName(d, tr), opName(s, tr))
      break
    case 'push': {
      const w = tr.mem.find((m) => m.kind === 'write')!
      summary = E.push(text, fmt(w.value), hex(w.address), hex(w.address))
      skipRegs.add(4)
      break
    }
    case 'pop': {
      const r = tr.mem.find((m) => m.kind === 'read' && !m.fetch)!
      const rsp = tr.regs.find((x) => x.index === 4)!
      summary = E.pop(text, fmt(r.value), opName(d, tr), hex(rsp.after))
      skipRegs.add(4)
      break
    }
    case 'add':
    case 'adc':
    case 'sub':
    case 'sbb':
    case 'cmp':
    case 'inc':
    case 'dec': {
      const sym = opSym[alu!.op]
      const isUnary = ins.op === 'inc' || ins.op === 'dec'
      const carry = ins.op === 'adc' || ins.op === 'sbb' ? ` ${sym} CF` : ''
      const expr = isUnary ? `${opName(d, tr)} ${sym} 1` : `${opName(d, tr)} ${sym} ${opName(s, tr)}${carry}`
      const carryVal = carry ? ` ${sym} ${alu!.carryIn ? 1 : 0}` : ''
      const calc = `${fmt(alu!.a, size)} ${sym} ${fmt(alu!.b!, size)}${carryVal} = ${fmt(alu!.result, size)}`
      summary = E.arith(text, expr, calc) + ' ' + (ins.op === 'cmp' ? E.discard : E.store(opName(d, tr)))
      if (isUnary) notes.push(E.incdecCF)
      break
    }
    case 'neg':
      summary = E.neg(text, `0 ${MINUS} ${fmt(alu!.a, size)} = ${fmt(alu!.result, size)}`) + ' ' + E.store(opName(d, tr))
      break
    case 'and':
    case 'or':
    case 'xor':
    case 'test': {
      const sym = opSym[alu!.op]
      const calc = `${hex(alu!.a, size)} ${sym} ${hex(alu!.b!, size)} = ${hex(alu!.result, size)}`
      summary = E.arith(text, `${opName(d, tr)} ${sym} ${opName(s, tr)}`, calc) + ' ' + (ins.op === 'test' ? E.discard : E.store(opName(d, tr)))
      break
    }
    case 'not':
      summary = E.not(text, `~${hex(alu!.a, size)} = ${hex(alu!.result, size)}`)
      break
    case 'shl':
    case 'sal':
    case 'shr':
    case 'sar': {
      const n = tr.count ?? 0
      const raw = s.k === 'imm' ? Number(s.value) : n
      if (n === 0) summary = `\`${text}\`: ${E.shiftZero}`
      else {
        const dir = ins.op === 'shl' || ins.op === 'sal' ? E.shiftLeft : E.shiftRight
        const kind = ins.op === 'sar' ? E.shiftArith : ins.op === 'shr' ? E.shiftLogical : ''
        summary = E.shift(text, dir, n, kind) + ` ${hex(alu!.a, size)} → ${hex(alu!.result, size)}.`
      }
      if (s.k === 'imm' && raw !== n) notes.push(E.shiftMasked(raw, n))
      break
    }
    case 'rol':
    case 'ror': {
      const dir = ins.op === 'rol' ? E.shiftLeft : E.shiftRight
      summary = E.rotate(text, dir, tr.count ?? 0) + ` ${hex(alu!.a, size)} → ${hex(alu!.result, size)}.`
      break
    }
    case 'mul':
    case 'imul': {
      const signedFmt = (v: bigint) => (alu!.signed ? fmt(v, size) : fmtU(v, size))
      if (ins.operands.length === 1) {
        const lo = regUpper(regName(0, size))
        const hi = size === 1 ? 'AH' : regUpper(regName(2, size))
        const dst = size === 1 ? 'AX' : `${hi}:${lo}`
        summary = E.mul(text, dst, `${lo} · ${opName(d, tr)} = ${signedFmt(alu!.a)} · ${signedFmt(alu!.b!)}`)
        notes.push(E.mulHalves(hi, lo) + ` ${hi} = ${hex(alu!.high!, size)}, ${lo} = ${hex(alu!.result, size)}.`)
      } else {
        const srcName = ins.operands.length === 3 ? `${opName(s, tr)} · ${opName(third, tr)}` : s.k === 'imm' ? `${opName(d, tr)} · ${opName(s, tr)}` : `${opName(d, tr)} · ${opName(s, tr)}`
        summary = E.imul(text, opName(d, tr), `${srcName} = ${fmt(alu!.a, size)} · ${fmt(alu!.b!, size)} = ${fmt(alu!.result, size)}`)
      }
      break
    }
    case 'div':
    case 'idiv': {
      const lo = regUpper(regName(0, size))
      const hi = size === 1 ? 'AH' : regUpper(regName(2, size))
      const dividendName = size === 1 ? 'AX' : `${hi}:${lo}`
      const dsize = (size * 2 > 8 ? 8 : size * 2) as Size
      const dv = alu!.signed ? (size === 8 ? toSigned(alu!.a, 8).toString() : fmt(alu!.a, dsize)) : (alu!.a < 65536n ? alu!.a.toString() : '0x' + alu!.a.toString(16).toUpperCase())
      const f = (v: bigint) => (alu!.signed ? fmt(v, size) : fmtU(v, size))
      summary = E.div(text, `${dividendName} / ${opName(d, tr)}`, `${dv} / ${f(alu!.b!)} = ${f(alu!.result)} ${E.remainder} ${f(alu!.high!)}`, `${size === 1 ? 'AL' : lo} = ${f(alu!.result)}`, `${hi} = ${f(alu!.high!)}`)
      break
    }
    case 'jmp':
      summary = E.jmp(text, target(tr.branch!.target!))
      break
    case 'jcc': {
      const c = t().conditions[ins.cond!.key]
      summary = E.jcc(text, ins.cond!.key, c.formula, condValues(c.formula, tr), tr.branch!.taken, target(tr.branch!.target!))
      break
    }
    case 'loop': {
      const rcx = tr.regs.find((r) => r.index === 1)!
      summary = E.loop(text, fmt(rcx.after), tr.branch!.taken, target(tr.branch!.target!))
      skipRegs.add(1)
      break
    }
    case 'setcc': {
      const c = t().conditions[ins.cond!.key]
      summary = E.setcc(text, ins.cond!.key, c.formula, condValues(c.formula, tr), tr.branch!.taken, opName(d, tr))
      break
    }
    case 'cmovcc': {
      const c = t().conditions[ins.cond!.key]
      const read = tr.mem.find((m) => m.kind === 'read' && !m.fetch)
      const value = read ? fmt(read.value, size) : s.k === 'reg' ? opName(s, tr) : ''
      summary = E.cmov(text, ins.cond!.key, c.formula, condValues(c.formula, tr), tr.branch!.taken, opName(d, tr), value)
      if (tr.cmovZeroExtend && d.k === 'reg') {
        notes.push(E.cmovZeroExtend(regUpper(regName(d.reg.index, 8))))
        skipRegs.add(d.reg.index)
      }
      break
    }
    case 'call': {
      const w = tr.mem.find((m) => m.kind === 'write')!
      const sym = symbolize(program, Number(w.value))
      summary = E.call(text, hex(w.value), sym ? ` (${sym})` : '', hex(w.address), target(tr.branch!.target!))
      skipRegs.add(4)
      break
    }
    case 'ret': {
      const rsp = tr.regs.filter((r) => r.index === 4)
      const sym = symbolize(program, tr.branch!.target!)
      summary = E.ret(text, hex(tr.branch!.target!), sym ? ` (${sym})` : '', hex(rsp[0].after))
      if (d && d.k === 'imm') notes.push(E.retImm(fmt(d.value)) + ` RSP = ${hex(rsp.at(-1)!.after)}.`)
      skipRegs.add(4)
      break
    }
    case 'cbw':
    case 'cwde':
    case 'cdqe': {
      const half = (size / 2) as Size
      const after = trunc(written()!.after, size)
      summary = E.signExtend(text, regName(0, size), regName(0, half), fmt(after, size), msb(after, size) ? '1' : '0')
      break
    }
    case 'cwd':
    case 'cdq':
    case 'cqo': {
      const after = trunc(written()!.after, size)
      summary = E.signExtendPair(text, regName(2, size), regName(0, size), fmt(after, size), after ? '1' : '0')
      break
    }
    case 'nop':
      summary = E.nop(text)
      break
    case 'hlt':
      summary = E.hlt(text)
      break
    case 'syscall': {
      const sc = tr.syscall!
      if (sc.number === 1n) {
        if (sc.bytes) {
          const r = tr.mem.find((m) => m.kind === 'read' && !m.fetch)!
          summary = E.syscallWrite(sc.bytes.length, hex(r.address), sc.fd!, bytesText(sc.bytes))
        } else summary = E.syscallWriteBadFd(sc.fd!)
        notes.push(E.syscallClobber)
      } else summary = E.syscallExit(sc.exitCode!)
      skipRegs.add(1).add(11).add(0)
      break
    }
  }

  const stackOps = ['push', 'pop', 'call', 'ret', 'syscall']
  if (!stackOps.includes(ins.op)) notes.push(...memNotes(tr))
  notes.push(...regNotes(tr, skipRegs))
  return { summary, notes, flags: flagNotes(tr) }
}
