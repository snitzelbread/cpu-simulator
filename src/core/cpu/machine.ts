/**
 * The x86-64 emulator. Executes pre-decoded instructions from an assembled Program.
 *
 * Every step produces a StepTrace that records all changes (registers, memory,
 * flags, RIP, console). The trace is used both for the explanation/visualisation
 * and as an undo record, which makes unlimited "step back" cheap.
 */
import type { Program } from '../assembler'
import { evalCondition } from '../isa'
import { STACK_SIZE } from '../layout'
import { regName, type RegInfo } from '../registers'
import type { ImmOperand, Instruction, MemOperand, Operand } from '../types'
import { hex, mask, msb, parityEven, toSigned, trunc, type Size } from '../util'
import { Memory } from './memory'
import {
  FLAG_BITS,
  FLAG_NAMES,
  type AluInfo,
  type ConsoleEntry,
  type Fault,
  type FaultCode,
  type FlagName,
  type Flags,
  type MachineStatus,
  type StackOrigin,
  type StepTrace,
} from './state'

const RAX = 0, RCX = 1, RDX = 2, RSP = 4, R11 = 11

class FaultException extends Error {
  readonly fault: Fault
  constructor(code: FaultCode, params?: Record<string, string | number>) {
    super(code)
    this.fault = { code, params }
  }
}

const SYSCALL_NAMES: Record<string, string> = {
  0: 'read', 1: 'write', 2: 'open', 3: 'close', 9: 'mmap', 12: 'brk', 39: 'getpid', 57: 'fork',
  59: 'execve', 60: 'exit', 62: 'kill', 231: 'exit_group',
}

export const MAX_WRITE = 4096

export interface RunResult {
  steps: number
  reason: 'breakpoint' | 'stopped' | 'limit' | 'condition'
}

export class Machine {
  readonly program: Program
  regs: bigint[] = new Array(16).fill(0n)
  rip: number
  flags: Flags = { CF: false, PF: false, ZF: false, SF: false, OF: false }
  mem = new Memory()
  status: MachineStatus = 'ready'
  fault?: Fault
  exitCode?: number
  console: ConsoleEntry[] = []
  history: StepTrace[] = []
  /** Which instruction wrote each stack slot (keyed by address). */
  stackOrigins = new Map<number, StackOrigin>()
  /** Steps executed in total, including ones dropped from history. */
  stepCount = 0
  historyLimit = 200_000

  private cur!: StepTrace

  constructor(program: Program) {
    this.program = program
    for (const s of Object.values(program.sections)) this.mem.writeBytes(s.start, s.bytes)
    this.rip = program.entry
    this.regs[RSP] = BigInt(program.stackTop)
  }

  // ---------------------------------------------------------------- state access

  get rflags(): bigint {
    // bit 1 is always 1; IF (bit 9) is set in user mode, like gdb shows (e.g. 0x246)
    let v = (1n << 1n) | (1n << 9n)
    for (const f of FLAG_NAMES) if (this.flags[f]) v |= 1n << BigInt(FLAG_BITS[f])
    return v
  }

  get done(): boolean {
    return this.status !== 'ready'
  }

  /** The instruction RIP points at (what the next step will execute). */
  get current(): Instruction | undefined {
    return this.program.byAddress.get(this.rip)
  }

  inStack(addr: number): boolean {
    return addr < this.program.stackTop && addr >= this.program.stackTop - STACK_SIZE
  }

  // ---------------------------------------------------------------- stepping

  step(): StepTrace | null {
    if (this.done) return null
    const instr = this.program.byAddress.get(this.rip)
    const t: StepTrace = {
      step: this.stepCount,
      instr: instr ?? this.program.instructions[0],
      ripBefore: this.rip,
      ripAfter: this.rip,
      regs: [],
      mem: [],
      flagsBefore: { ...this.flags },
      flagsAfter: { ...this.flags },
      flagsAffected: [],
      flagsUndefined: [],
      statusBefore: this.status,
      statusAfter: this.status,
      consoleBefore: this.console.length,
    }
    this.cur = t
    try {
      if (!instr) {
        const text = this.program.sections.text
        if (this.rip === text.start + text.size) throw new FaultException('endOfCode')
        throw new FaultException('noInstruction', { address: hex(this.rip) })
      }
      t.mem.push({ kind: 'read', address: instr.address, size: instr.length, value: 0n, fetch: true })
      // RIP is advanced *before* execution: relative jumps and call's return
      // address are based on the address of the next instruction.
      this.rip = instr.address + instr.length
      this.execute(instr)
    } catch (e) {
      if (!(e instanceof FaultException)) throw e
      // A fault leaves the architectural state as it was before the instruction.
      this.revert(t)
      t.regs = []
      t.mem = t.mem.filter((m) => m.kind === 'read')
      t.fault = e.fault
      this.fault = e.fault
      this.status = 'faulted'
    }
    t.ripAfter = this.rip
    t.flagsAfter = { ...this.flags }
    t.statusAfter = this.status
    this.history.push(t)
    if (this.history.length > this.historyLimit) this.history.shift()
    this.stepCount++
    return t
  }

  canStepBack(): boolean {
    return this.history.length > 0
  }

  stepBack(): StepTrace | null {
    const t = this.history.pop()
    if (!t) return null
    this.revert(t)
    this.stepCount--
    return t
  }

  private revert(t: StepTrace) {
    for (let i = t.regs.length - 1; i >= 0; i--) this.regs[t.regs[i].index] = t.regs[i].before
    for (let i = t.mem.length - 1; i >= 0; i--) {
      const m = t.mem[i]
      if (m.kind !== 'write' || !m.before) continue
      this.mem.writeBytes(m.address, m.before)
      if (this.inStack(m.address)) {
        if (m.prevOrigin) this.stackOrigins.set(m.address, m.prevOrigin)
        else this.stackOrigins.delete(m.address)
      }
    }
    this.flags = { ...t.flagsBefore }
    this.rip = t.ripBefore
    this.console.length = t.consoleBefore
    this.status = t.statusBefore
    if (this.status !== 'exited') this.exitCode = undefined
    if (this.status !== 'faulted') this.fault = undefined
  }

  /**
   * Run until `stop` returns true (checked before each step), a breakpoint is hit,
   * the program ends, or `limit` steps were executed.
   */
  run(opts: { limit: number; breakpoints?: Set<number>; stop?: (m: Machine) => boolean; skipFirstBreakpoint?: boolean }): RunResult {
    let steps = 0
    while (!this.done) {
      if (steps >= opts.limit) return { steps, reason: 'limit' }
      if (opts.stop?.(this)) return { steps, reason: 'condition' }
      if (opts.breakpoints?.has(this.rip) && !(steps === 0 && opts.skipFirstBreakpoint)) return { steps, reason: 'breakpoint' }
      this.step()
      steps++
    }
    return { steps, reason: 'stopped' }
  }

  /** Execute a `call` (including everything it calls) as one step. */
  stepOver(opts: { limit: number; breakpoints?: Set<number> }): RunResult {
    const ins = this.current
    if (!ins || ins.op !== 'call') {
      this.step()
      return { steps: 1, reason: 'condition' }
    }
    const next = ins.address + ins.length
    const rsp = this.regs[RSP]
    this.step()
    const r = this.run({ ...opts, stop: (m) => m.rip === next && m.regs[RSP] >= rsp })
    return { steps: r.steps + 1, reason: r.reason }
  }

  // ---------------------------------------------------------------- primitives

  readReg(r: RegInfo): bigint {
    const v = this.regs[r.index]
    if (r.high8) return (v >> 8n) & 0xffn
    return trunc(v, r.size)
  }

  /**
   * x86-64 register write semantics: 64-bit writes replace the register; 32-bit
   * writes zero-extend into bits 63..32; 8- and 16-bit writes leave the other bits alone.
   */
  writeReg(r: RegInfo, value: bigint) {
    const before = this.regs[r.index]
    let after: bigint
    if (r.size === 8) after = trunc(value, 8)
    else if (r.size === 4) after = trunc(value, 4)
    else if (r.high8) after = (before & ~0xff00n) | (trunc(value, 1) << 8n)
    else after = (before & ~mask(r.size)) | trunc(value, r.size)
    this.regs[r.index] = after
    this.cur.regs.push({ index: r.index, before, after, name: r.name, size: r.size, high8: r.high8, zeroExtended: r.size === 4 })
  }

  private reg64(index: number): RegInfo {
    return { name: regName(index, 8), index, size: 8, high8: false, needsRex: index >= 8 }
  }

  private reg(index: number, size: Size): RegInfo {
    return { name: regName(index, size), index, size, high8: false, needsRex: index >= 8 }
  }

  ea(m: MemOperand): bigint {
    let a = m.disp
    if (m.base) a += this.regs[m.base.index]
    if (m.index) a += this.regs[m.index.index] * BigInt(m.scale)
    return trunc(a, 8)
  }

  readMem(addr: bigint, size: number): bigint {
    const a = Number(addr)
    const v = this.mem.read(a, size)
    this.cur.mem.push({ kind: 'read', address: a, size, value: v })
    return v
  }

  writeMem(addr: bigint, size: number, value: bigint, origin?: StackOrigin['kind']) {
    const a = Number(addr)
    const text = this.program.sections.text
    if (a < text.start + text.size && a + size > text.start) throw new FaultException('writeToCode', { address: hex(a) })
    const before = this.mem.readBytes(a, size)
    const v = trunc(value, size as Size)
    let prevOrigin: StackOrigin | undefined
    if (this.inStack(a)) {
      prevOrigin = this.stackOrigins.get(a)
      this.stackOrigins.set(a, { kind: origin ?? 'write', line: this.cur.instr.line, text: this.cur.instr.text })
    }
    this.mem.write(a, size, v)
    this.cur.mem.push({ kind: 'write', address: a, size, value: v, before, prevOrigin })
  }

  private read(op: Operand, size: Size): bigint {
    if (op.k === 'reg') return this.readReg(op.reg)
    if (op.k === 'imm') return trunc((op as ImmOperand).value, size)
    const a = this.ea(op)
    this.cur.ea = a
    return this.readMem(a, size)
  }

  private write(op: Operand, size: Size, value: bigint) {
    if (op.k === 'reg') return this.writeReg(op.reg, value)
    if (op.k === 'mem') {
      const a = this.ea(op)
      this.cur.ea = a
      return this.writeMem(a, size, value)
    }
    throw new Error('cannot write to immediate')
  }

  private push(value: bigint, origin: StackOrigin['kind'] = 'push') {
    const rsp = trunc(this.regs[RSP] - 8n, 8)
    this.writeReg(this.reg64(RSP), rsp)
    this.writeMem(rsp, 8, value, origin)
  }

  private pop(): bigint {
    const rsp = this.regs[RSP]
    const v = this.readMem(rsp, 8)
    this.writeReg(this.reg64(RSP), rsp + 8n)
    return v
  }

  // ---------------------------------------------------------------- flags

  private setFlags(values: Partial<Flags>, undef: FlagName[] = []) {
    for (const [k, v] of Object.entries(values) as [FlagName, boolean][]) this.flags[k] = v
    this.cur.flagsAffected = [...(Object.keys(values) as FlagName[]), ...undef]
    this.cur.flagsUndefined = undef
  }

  private szp(r: bigint, size: Size) {
    return { SF: msb(r, size), ZF: trunc(r, size) === 0n, PF: parityEven(r) }
  }

  private add(a: bigint, b: bigint, size: Size, carry: boolean, op = '+'): bigint {
    const full = a + b + (carry ? 1n : 0n)
    const r = trunc(full, size)
    this.setFlags({
      CF: full > mask(size),
      OF: msb(a, size) === msb(b, size) && msb(r, size) !== msb(a, size),
      ...this.szp(r, size),
    })
    this.cur.alu = { op, size, a, b, carryIn: carry || undefined, result: r }
    return r
  }

  private sub(a: bigint, b: bigint, size: Size, borrow: boolean, op = '-'): bigint {
    const bb = b + (borrow ? 1n : 0n)
    const r = trunc(a - bb, size)
    this.setFlags({
      CF: a < bb,
      OF: msb(a, size) !== msb(b, size) && msb(r, size) !== msb(a, size),
      ...this.szp(r, size),
    })
    this.cur.alu = { op, size, a, b, carryIn: borrow || undefined, result: r }
    return r
  }

  private logic(a: bigint, b: bigint, size: Size, op: string): bigint {
    const r = op === '&' ? a & b : op === '|' ? a | b : a ^ b
    // SDM: OF and CF are cleared; SF, ZF, PF set according to the result; AF undefined
    this.setFlags({ CF: false, OF: false, ...this.szp(r, size) })
    this.cur.alu = { op, size, a, b, result: r }
    return r
  }

  // ---------------------------------------------------------------- execute

  private execute(ins: Instruction) {
    const ops = ins.operands
    const [d, s] = ops
    const size = ins.opSize ?? 8
    const t = this.cur

    switch (ins.op) {
      case 'nop':
        return
      case 'hlt':
        // In a real user-mode process hlt raises #GP; the simulator treats it as "stop".
        this.status = 'halted'
        return
      case 'mov':
        this.write(d, size, this.read(s, size))
        return
      case 'movzx':
      case 'movsx':
      case 'movsxd': {
        const ss = (s.k === 'reg' ? s.reg.size : (s as MemOperand).size!) as Size
        const v = this.read(s, ss)
        this.write(d, size, ins.op === 'movzx' ? v : trunc(toSigned(v, ss), size))
        return
      }
      case 'lea': {
        const a = this.ea(s as MemOperand)
        t.ea = a
        this.write(d, size, a)
        return
      }
      case 'xchg': {
        const a = this.read(d, size)
        const b = this.read(s, size)
        this.write(d, size, b)
        this.write(s, size, a)
        return
      }
      case 'push': {
        const v = d.k === 'imm' ? trunc(d.value, 8) : this.read(d, 8)
        this.push(v)
        return
      }
      case 'pop': {
        const v = this.pop()
        // SDM: for pop into memory the address is computed after RSP is incremented
        this.write(d, 8, v)
        return
      }
      case 'add':
      case 'adc': {
        const r = this.add(this.read(d, size), this.read(s, size), size, ins.op === 'adc' && this.flags.CF)
        this.write(d, size, r)
        return
      }
      case 'sub':
      case 'sbb':
      case 'cmp': {
        const r = this.sub(this.read(d, size), this.read(s, size), size, ins.op === 'sbb' && this.flags.CF)
        if (ins.op === 'cmp') t.alu!.discarded = true
        else this.write(d, size, r)
        return
      }
      case 'inc':
      case 'dec': {
        // inc/dec do not modify CF
        const cf = this.flags.CF
        const a = this.read(d, size)
        const r = ins.op === 'inc' ? this.add(a, 1n, size, false) : this.sub(a, 1n, size, false)
        this.flags.CF = cf
        t.flagsAffected = t.flagsAffected.filter((f) => f !== 'CF')
        this.write(d, size, r)
        return
      }
      case 'neg': {
        const a = this.read(d, size)
        const r = trunc(-a, size)
        // SDM: CF = 0 if the source is 0, else 1. OF set for the most negative value.
        this.setFlags({ CF: a !== 0n, OF: a === 1n << BigInt(size * 8 - 1), ...this.szp(r, size) })
        t.alu = { op: 'neg', size, a, result: r }
        this.write(d, size, r)
        return
      }
      case 'and':
      case 'or':
      case 'xor': {
        const sym = ins.op === 'and' ? '&' : ins.op === 'or' ? '|' : '^'
        this.write(d, size, this.logic(this.read(d, size), this.read(s, size), size, sym))
        return
      }
      case 'test': {
        this.logic(this.read(d, size), this.read(s, size), size, '&')
        t.alu!.discarded = true
        t.alu!.op = 'test'
        return
      }
      case 'not': {
        const a = this.read(d, size)
        const r = trunc(~a, size)
        t.alu = { op: '~', size, a, result: r }
        this.write(d, size, r)
        return
      }
      case 'shl':
      case 'sal':
      case 'shr':
      case 'sar':
        return this.shift(ins, size)
      case 'rol':
      case 'ror':
        return this.rotate(ins, size)
      case 'mul':
      case 'imul':
        if (ops.length === 1) return this.mulWide(ins, size)
        return this.imulTrunc(ins, size)
      case 'div':
      case 'idiv':
        return this.divide(ins, size)
      case 'jmp': {
        const target = d.k === 'imm' ? Number(d.value) : Number(this.read(d, 8))
        t.branch = { taken: true, target }
        this.rip = target
        return
      }
      case 'jcc': {
        const taken = evalCondition(ins.cond!.key, this.flags)
        const target = Number((d as ImmOperand).value)
        t.branch = { cond: ins.cond!.key, taken, target }
        if (taken) this.rip = target
        return
      }
      case 'loop': {
        // loop decrements RCX (without touching flags) and jumps if RCX != 0
        const rcx = trunc(this.regs[RCX] - 1n, 8)
        this.writeReg(this.reg64(RCX), rcx)
        const target = Number((d as ImmOperand).value)
        t.branch = { taken: rcx !== 0n, target }
        if (rcx !== 0n) this.rip = target
        return
      }
      case 'call': {
        const target = d.k === 'imm' ? Number(d.value) : Number(this.read(d, 8))
        this.push(BigInt(this.rip), 'call')
        t.branch = { taken: true, target }
        this.rip = target
        return
      }
      case 'ret': {
        // Returning from _start (nothing was called) would crash a real process.
        if (this.regs[RSP] >= BigInt(this.program.stackTop)) throw new FaultException('retEmptyStack')
        const target = Number(this.pop())
        if (d) this.writeReg(this.reg64(RSP), this.regs[RSP] + (d as ImmOperand).value)
        t.branch = { taken: true, target }
        this.rip = target
        return
      }
      case 'setcc': {
        const v = evalCondition(ins.cond!.key, this.flags)
        t.branch = { cond: ins.cond!.key, taken: v }
        this.write(d, 1, v ? 1n : 0n)
        return
      }
      case 'cmovcc': {
        // The source is read even if the condition is false.
        const v = this.read(s, size)
        const c = evalCondition(ins.cond!.key, this.flags)
        t.branch = { cond: ins.cond!.key, taken: c }
        if (c) this.write(d, size, v)
        else if (size === 4 && d.k === 'reg') {
          // SDM: in 64-bit mode a 32-bit CMOVcc clears bits 63..32 even when the condition is false.
          this.writeReg(d.reg, this.readReg(d.reg))
          t.cmovZeroExtend = true
        }
        return
      }
      case 'syscall':
        return this.syscall()
    }
  }

  private shiftCount(ins: Instruction, size: Size): number {
    const c = ins.operands[1]
    const raw = c.k === 'imm' ? Number(c.value) : Number(this.readReg((c as { reg: RegInfo }).reg))
    // SDM: the count is masked to 6 bits for 64-bit operands, 5 bits otherwise
    return raw & (size === 8 ? 0x3f : 0x1f)
  }

  private shift(ins: Instruction, size: Size) {
    const d = ins.operands[0]
    const n = this.shiftCount(ins, size)
    const a = this.read(d, size)
    const t = this.cur
    t.count = n
    const W = size * 8
    const opSym = ins.op === 'shr' ? '>>>' : ins.op === 'sar' ? '>>' : '<<'
    if (n === 0) {
      // SDM: a masked count of 0 affects no flags
      t.alu = { op: opSym, size, a, b: 0n, result: a }
      this.write(d, size, a)
      return
    }
    const N = BigInt(n)
    let r: bigint
    let cf: boolean
    let of: boolean | undefined
    if (ins.op === 'shl' || ins.op === 'sal') {
      r = trunc(a << N, size)
      cf = n <= W ? ((a >> BigInt(W - n)) & 1n) === 1n : false // last bit shifted out
      of = msb(r, size) !== cf
    } else if (ins.op === 'shr') {
      r = n >= W ? 0n : a >> N
      cf = n <= W ? ((a >> (N - 1n)) & 1n) === 1n : false
      of = msb(a, size)
    } else {
      const sa = toSigned(a, size)
      r = trunc(sa >> N, size)
      cf = ((sa >> (N - 1n)) & 1n) === 1n
      of = false
    }
    const values: Partial<Flags> = { ...this.szp(r, size), CF: cf }
    const undef: FlagName[] = []
    // OF is only defined for 1-bit shifts; CF is undefined if the count is >= the operand width (8/16-bit)
    if (n === 1) values.OF = of
    else undef.push('OF')
    // SDM: "CF is undefined for SHL and SHR where the count is >= the operand size" (only reachable for 8/16-bit)
    if (n >= W && ins.op !== 'sar') {
      delete values.CF
      undef.push('CF')
    }
    this.setFlags(values, undef)
    t.alu = { op: opSym, size, a, b: N, result: r }
    this.write(d, size, r)
  }

  private rotate(ins: Instruction, size: Size) {
    const d = ins.operands[0]
    const masked = this.shiftCount(ins, size)
    const W = size * 8
    const a = this.read(d, size)
    const t = this.cur
    t.count = masked
    const n = BigInt(masked % W)
    let r: bigint
    if (ins.op === 'rol') r = trunc((a << n) | (a >> (BigInt(W) - n)), size)
    else r = trunc((a >> n) | (a << (BigInt(W) - n)), size)
    if (n === 0n) r = a
    t.alu = { op: ins.op, size, a, b: BigInt(masked), result: r }
    if (masked !== 0) {
      // SDM: rotates only affect CF and OF. OF is defined only for 1-bit rotates.
      const cf = ins.op === 'rol' ? (r & 1n) === 1n : msb(r, size)
      const values: Partial<Flags> = { CF: cf }
      const undef: FlagName[] = []
      if (masked === 1) values.OF = ins.op === 'rol' ? msb(r, size) !== cf : msb(r, size) !== (((r >> BigInt(W - 2)) & 1n) === 1n)
      else undef.push('OF')
      this.setFlags(values, undef)
    }
    this.write(d, size, r)
  }

  /** One-operand mul/imul: AL/AX/EAX/RAX * src -> AX / DX:AX / EDX:EAX / RDX:RAX */
  private mulWide(ins: Instruction, size: Size) {
    const src = this.read(ins.operands[0], size)
    const acc = this.readReg(this.reg(RAX, size))
    const signed = ins.op === 'imul'
    const W = BigInt(size * 8)
    let product: bigint
    let overflow: boolean
    if (signed) {
      const p = toSigned(acc, size) * toSigned(src, size)
      product = p & ((1n << (2n * W)) - 1n) // two's complement of the double-width product
      overflow = p !== toSigned(p, size)
    } else {
      product = acc * src
      overflow = product >> W !== 0n
    }
    const low = product & mask(size)
    const high = (product >> W) & mask(size)
    if (size === 1) this.writeReg(this.reg(RAX, 2), product)
    else {
      this.writeReg(this.reg(RAX, size), low)
      this.writeReg(this.reg(RDX, size), high)
    }
    // SDM: CF=OF=1 if the upper half is significant; SF, ZF, AF, PF undefined
    this.setFlags({ CF: overflow, OF: overflow }, ['SF', 'ZF', 'PF'])
    this.cur.alu = { op: '*', size, a: acc, b: src, result: low, high, signed }
  }

  /** imul r, r/m  and  imul r, r/m, imm: truncated product. */
  private imulTrunc(ins: Instruction, size: Size) {
    const [d, s, i] = ins.operands
    const a = this.read(s.k === 'imm' ? d : s, size)
    const b = i ? trunc((i as ImmOperand).value, size) : s.k === 'imm' ? trunc(s.value, size) : this.read(d, size)
    const p = toSigned(a, size) * toSigned(b, size)
    const r = trunc(p, size)
    const overflow = p !== toSigned(p, size)
    this.setFlags({ CF: overflow, OF: overflow }, ['SF', 'ZF', 'PF'])
    this.cur.alu = { op: '*', size, a, b, result: r, signed: true }
    this.write(d, size, r)
  }

  /** div/idiv: AX / DX:AX / EDX:EAX / RDX:RAX divided by src. */
  private divide(ins: Instruction, size: Size) {
    const signed = ins.op === 'idiv'
    const divisor = this.read(ins.operands[0], size)
    const W = BigInt(size * 8)
    const dividend = size === 1 ? this.readReg(this.reg(RAX, 2)) : (this.readReg(this.reg(RDX, size)) << W) | this.readReg(this.reg(RAX, size))
    if (divisor === 0n) throw new FaultException('divideError')
    let q: bigint
    let r: bigint
    if (signed) {
      const n = toSigned(dividend, (size * 2) as Size)
      const dv = toSigned(divisor, size)
      q = n / dv // BigInt division truncates toward zero, like idiv
      r = n % dv // remainder has the sign of the dividend
      if (q !== toSigned(q, size)) throw new FaultException('divideOverflow', { quotient: q.toString() })
    } else {
      q = dividend / divisor
      r = dividend % divisor
      if (q > mask(size)) throw new FaultException('divideOverflow', { quotient: q.toString() })
    }
    if (size === 1) {
      this.writeReg({ name: 'al', index: 0, size: 1, high8: false, needsRex: false }, q)
      this.writeReg({ name: 'ah', index: 0, size: 1, high8: true, needsRex: false }, r)
    } else {
      this.writeReg(this.reg(RAX, size), q)
      this.writeReg(this.reg(RDX, size), r)
    }
    // SDM: all arithmetic flags are undefined after div/idiv
    this.setFlags({}, ['CF', 'OF', 'SF', 'ZF', 'PF'])
    this.cur.alu = { op: '/', size, a: dividend, b: divisor, result: trunc(q, size), high: trunc(r, size), signed }
  }

  private syscall() {
    const t = this.cur
    const nr = this.regs[RAX]
    const name = SYSCALL_NAMES[nr.toString()] ?? '?'
    if (nr !== 1n && nr !== 60n && nr !== 231n) throw new FaultException('unsupportedSyscall', { number: nr.toString(), name })
    // The syscall instruction itself stores the return address in RCX and RFLAGS in R11.
    this.writeReg(this.reg64(RCX), BigInt(this.rip))
    this.writeReg(this.reg64(R11), this.rflags)
    t.syscall = { number: nr, name }
    if (nr === 1n) {
      const fd = Number(this.regs[7])
      const count = this.regs[2]
      t.syscall.fd = fd
      if (count > BigInt(MAX_WRITE)) throw new FaultException('writeTooLong', { count: count.toString(), max: MAX_WRITE })
      let result: bigint
      if (fd === 1 || fd === 2) {
        const bytes = Array.from(this.mem.readBytes(Number(this.regs[6]), Number(count)))
        t.mem.push({ kind: 'read', address: Number(this.regs[6]), size: Number(count), value: 0n })
        this.console.push({ fd, bytes })
        t.syscall.bytes = bytes
        result = count
      } else result = trunc(-9n, 8) // -EBADF
      t.syscall.result = result
      this.writeReg(this.reg64(RAX), result)
      return
    }
    // exit / exit_group: the parent sees status & 0xFF
    const code = Number(this.regs[7] & 0xffn)
    t.syscall.exitCode = code
    this.exitCode = code
    this.status = 'exited'
  }
}

export type { AluInfo }
