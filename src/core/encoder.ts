/**
 * x86-64 machine-code encoder for the simulator's instruction subset.
 *
 * The choices between equivalent encodings follow what NASM (with its default
 * optimisation level -Ox) emits, so that instruction lengths and addresses match
 * a real `nasm -f bin` build. Tests verify this against nasm when it is installed.
 */
import { fail } from './errors'
import type { Condition, Op } from './isa'
import type { RegInfo } from './registers'
import type { ImmOperand, MemOperand, Operand, RegOperand } from './types'
import { fitsEither, fitsSigned, toSigned, trunc, type Size } from './util'

export interface EncodeInput {
  op: Op
  cond?: Condition
  mnemonic: string
  operands: Operand[]
}

export interface EncodeOptions {
  address: number
  /** Use the rel32 form for jmp/jcc (decided by the assembler's relaxation). */
  longJump?: boolean
}

export interface Encoded {
  bytes: number[]
  opSize?: Size
  /** For jmp/jcc: whether the chosen short form could not reach the target. */
  jumpOutOfRange?: boolean
  /** Byte positions of the displacement, immediate and branch offset (object files patch these). */
  fields: { disp?: Field; imm?: Field; rel?: Field }
}

export interface Field {
  offset: number
  size: number
}

type RM = RegOperand | MemOperand

/** Register number as encoded: AH/CH/DH/BH use the numbers 4..7 (without REX). */
function code(r: RegInfo): number {
  return r.high8 ? r.index + 4 : r.index
}

interface Parts {
  opSize?: Size
  /** Emit 0x66 */
  p66?: boolean
  rexW?: boolean
  opcode: number[]
  /** Register added to the last opcode byte (B8+r etc.). */
  plusReg?: RegInfo
  /** ModRM: reg field is either a register or an opcode extension /digit. */
  modReg?: RegInfo | number
  modRM?: RM
  imm?: { value: bigint; size: 1 | 2 | 4 | 8 }
  rel?: { target: bigint; size: 1 | 4 }
}

const ALU: Partial<Record<Op, number>> = { add: 0, or: 1, adc: 2, sbb: 3, and: 4, sub: 5, xor: 6, cmp: 7 }
const SHIFT: Partial<Record<Op, number>> = { rol: 0, ror: 1, shl: 4, sal: 4, shr: 5, sar: 7 }
const UNARY: Partial<Record<Op, [number, number]>> = {
  inc: [0xfe, 0], dec: [0xfe, 1], not: [0xf6, 2], neg: [0xf6, 3], mul: [0xf6, 4], imul: [0xf6, 5], div: [0xf6, 6], idiv: [0xf6, 7],
}

/** Sign-extension instructions and their operation size (the destination width). */
export const SIGN_EXT: Partial<Record<Op, Size>> = { cbw: 2, cwde: 4, cdqe: 8, cwd: 2, cdq: 4, cqo: 8 }

const isReg = (o: Operand | undefined): o is RegOperand => o?.k === 'reg'
const isMem = (o: Operand | undefined): o is MemOperand => o?.k === 'mem'
const isImm = (o: Operand | undefined): o is ImmOperand => o?.k === 'imm'
const isRM = (o: Operand | undefined): o is RM => isReg(o) || isMem(o)

function rmSize(o: RM): Size | undefined {
  return o.k === 'reg' ? o.reg.size : o.size
}

function count(ops: Operand[], n: number | number[]) {
  const ok = Array.isArray(n) ? n.includes(ops.length) : ops.length === n
  if (!ok) fail('operandCount', { expected: Array.isArray(n) ? n.join('/') : n, got: ops.length })
}

/** Size of a reg/mem operand, requiring it to be known. */
function needSize(o: RM): Size {
  const s = rmSize(o)
  if (!s) fail('sizeUnknown')
  return s
}

/** Size of a binary (dst, src) operation where at least one is a register or sized memory. */
function pairSize(a: RM, b: RM): Size {
  const sa = rmSize(a)
  const sb = rmSize(b)
  if (sa && sb && sa !== sb) fail('sizeMismatch')
  const s = sa ?? sb
  if (!s) fail('sizeUnknown')
  return s
}

/** Validate an immediate for an operation of `size`; 64-bit ops take a sign-extended imm32. */
function checkImm(imm: ImmOperand, size: Size): bigint {
  if (imm.unresolved) return 0n
  const v = imm.value
  if (size === 8) {
    const t = trunc(v, 8)
    if (!fitsEither(v, 8) || toSigned(t, 4) !== toSigned(t, 8)) fail('imm64NotAllowed', { value: imm.text })
    return toSigned(t, 8)
  }
  if (!fitsEither(v, size)) fail('immOutOfRange', { value: imm.text, size })
  return trunc(v, size)
}

function fitsImm8(v: bigint, size: Size): boolean {
  return fitsSigned(toSigned(trunc(v, size), size), 1)
}

function sizeParts(size: Size, p: Parts): Parts {
  p.opSize = size
  if (size === 2) p.p66 = true
  if (size === 8) p.rexW = true
  return p
}

function immSizeFor(size: Size): 1 | 2 | 4 {
  return size === 1 ? 1 : size === 2 ? 2 : 4
}

function isAcc(o: RM): boolean {
  return o.k === 'reg' && o.reg.index === 0 && !o.reg.high8
}

function plan(ins: EncodeInput, longJump: boolean): Parts {
  const { op, operands: ops } = ins
  const [a, b, c] = ops

  const alu = ALU[op]
  if (alu !== undefined) {
    count(ops, 2)
    if (isRM(a) && isReg(b)) {
      const s = pairSize(a, b)
      return sizeParts(s, { opcode: [alu * 8 + (s === 1 ? 0 : 1)], modReg: b.reg, modRM: a })
    }
    if (isReg(a) && isMem(b)) {
      const s = pairSize(a, b)
      return sizeParts(s, { opcode: [alu * 8 + (s === 1 ? 2 : 3)], modReg: a.reg, modRM: b })
    }
    if (isRM(a) && isImm(b)) {
      const s = needSize(a)
      const v = checkImm(b, s)
      if (s === 1) {
        if (isAcc(a)) return sizeParts(s, { opcode: [alu * 8 + 4], imm: { value: v, size: 1 } })
        return sizeParts(s, { opcode: [0x80], modReg: alu, modRM: a, imm: { value: v, size: 1 } })
      }
      if (!b.unresolved && !b.reloc && fitsImm8(v, s)) return sizeParts(s, { opcode: [0x83], modReg: alu, modRM: a, imm: { value: v, size: 1 } })
      if (isAcc(a)) return sizeParts(s, { opcode: [alu * 8 + 5], imm: { value: v, size: immSizeFor(s) } })
      return sizeParts(s, { opcode: [0x81], modReg: alu, modRM: a, imm: { value: v, size: immSizeFor(s) } })
    }
    fail('invalidOperands', { name: ins.mnemonic })
  }

  const sh = SHIFT[op]
  if (sh !== undefined) {
    count(ops, 2)
    if (!isRM(a)) fail('invalidOperands', { name: ins.mnemonic })
    const s = needSize(a)
    const w = s === 1 ? 0 : 1
    if (isReg(b) && b.reg.index === 1 && b.reg.size === 1 && !b.reg.high8) {
      return sizeParts(s, { opcode: [0xd2 + w], modReg: sh, modRM: a })
    }
    if (isImm(b)) {
      if (!b.unresolved && (b.value < 0n || b.value > 255n)) fail('immOutOfRange', { value: b.text, size: 1 })
      if (b.value === 1n && !b.unresolved) return sizeParts(s, { opcode: [0xd0 + w], modReg: sh, modRM: a })
      return sizeParts(s, { opcode: [0xc0 + w], modReg: sh, modRM: a, imm: { value: b.value, size: 1 } })
    }
    fail('invalidOperands', { name: ins.mnemonic })
  }

  const un = UNARY[op]
  if (un !== undefined && !(op === 'imul' && ops.length > 1)) {
    count(ops, 1)
    if (!isRM(a)) fail('invalidOperands', { name: ins.mnemonic })
    const s = needSize(a)
    return sizeParts(s, { opcode: [un[0] + (s === 1 ? 0 : 1)], modReg: un[1], modRM: a })
  }

  switch (op) {
    case 'imul': {
      count(ops, [2, 3])
      if (!isReg(a) || a.reg.size === 1) fail('invalidOperands', { name: ins.mnemonic })
      // imul r, imm  ==  imul r, r, imm (NASM shorthand)
      const src: Operand = ops.length === 2 && isImm(b) ? a : b
      const imm = ops.length === 3 ? c : isImm(b) ? b : undefined
      if (!isRM(src)) fail('invalidOperands', { name: ins.mnemonic })
      const s = pairSize(a, src)
      if (!imm) return sizeParts(s, { opcode: [0x0f, 0xaf], modReg: a.reg, modRM: src })
      if (!isImm(imm)) fail('invalidOperands', { name: ins.mnemonic })
      const v = checkImm(imm, s)
      if (!imm.unresolved && !imm.reloc && fitsImm8(v, s)) return sizeParts(s, { opcode: [0x6b], modReg: a.reg, modRM: src, imm: { value: v, size: 1 } })
      return sizeParts(s, { opcode: [0x69], modReg: a.reg, modRM: src, imm: { value: v, size: immSizeFor(s) } })
    }
    case 'mov': {
      count(ops, 2)
      if (isRM(a) && isReg(b)) {
        const s = pairSize(a, b)
        return sizeParts(s, { opcode: [s === 1 ? 0x88 : 0x89], modReg: b.reg, modRM: a })
      }
      if (isReg(a) && isMem(b)) {
        const s = pairSize(a, b)
        return sizeParts(s, { opcode: [s === 1 ? 0x8a : 0x8b], modReg: a.reg, modRM: b })
      }
      if (isReg(a) && isImm(b)) {
        const s = a.reg.size
        if (s === 8) {
          if (!fitsEither(b.value, 8) && !b.unresolved) fail('immOutOfRange', { value: b.text, size: 8 })
          const t = trunc(b.value, 8)
          // Addresses of labels are relocatable: NASM keeps the full imm64 form ("movabs").
          if (b.reloc) return sizeParts(8, { opcode: [0xb8], plusReg: a.reg, imm: { value: t, size: 8 } })
          // NASM optimisation: mov r64, imm that fits in 32 bits unsigned -> mov r32, imm32
          // (identical effect because 32-bit writes zero-extend).
          if (t <= 0xffffffffn) return { opSize: 8, opcode: [0xb8], plusReg: a.reg, imm: { value: t, size: 4 } }
          const st = toSigned(t, 8)
          if (st < 0n && st >= -(1n << 31n)) return sizeParts(8, { opcode: [0xc7], modReg: 0, modRM: a, imm: { value: toSigned(t, 8), size: 4 } })
          return sizeParts(8, { opcode: [0xb8], plusReg: a.reg, imm: { value: t, size: 8 } })
        }
        const v = checkImm(b, s)
        return sizeParts(s, { opcode: [s === 1 ? 0xb0 : 0xb8], plusReg: a.reg, imm: { value: v, size: immSizeFor(s) } })
      }
      if (isMem(a) && isImm(b)) {
        const s = needSize(a)
        const v = checkImm(b, s)
        return sizeParts(s, { opcode: [s === 1 ? 0xc6 : 0xc7], modReg: 0, modRM: a, imm: { value: v, size: immSizeFor(s) } })
      }
      fail('invalidOperands', { name: ins.mnemonic })
    }
    // eslint-disable-next-line no-fallthrough
    case 'movzx':
    case 'movsx':
    case 'movsxd': {
      count(ops, 2)
      if (!isReg(a) || !isRM(b)) fail('invalidOperands', { name: ins.mnemonic })
      const ss = needSize(b)
      const ds = a.reg.size
      // NASM shortens sign-extension of the accumulator into itself: cbw / cwde / cdqe
      if (op !== 'movzx' && isAcc(a) && isReg(b) && isAcc(b) && ss * 2 === ds) return sizeParts(ds, { opcode: [0x98] })
      if (op === 'movsxd' || (op === 'movsx' && ss === 4)) {
        if (ds !== 8 || ss !== 4) fail('invalidOperands', { name: ins.mnemonic })
        return sizeParts(8, { opcode: [0x63], modReg: a.reg, modRM: b })
      }
      if (ss === 4 && op === 'movzx') fail('movzx32')
      if (ss >= ds) fail('invalidOperands', { name: ins.mnemonic })
      const base = op === 'movzx' ? 0xb6 : 0xbe
      return sizeParts(ds, { opcode: [0x0f, base + (ss === 2 ? 1 : 0)], modReg: a.reg, modRM: b })
    }
    case 'lea': {
      count(ops, 2)
      if (!isReg(a) || !isMem(b) || a.reg.size === 1) fail('invalidOperands', { name: ins.mnemonic })
      return sizeParts(a.reg.size, { opcode: [0x8d], modReg: a.reg, modRM: b })
    }
    case 'xchg': {
      count(ops, 2)
      if (isReg(a) && isReg(b)) {
        const s = pairSize(a, b)
        if (s !== 1 && (isAcc(a) || isAcc(b)) && !(s === 4 && isAcc(a) && isAcc(b))) {
          const other = isAcc(a) ? b : a
          return sizeParts(s, { opcode: [0x90], plusReg: other.reg })
        }
        // NASM puts the first operand in the ModRM reg field
        return sizeParts(s, { opcode: [s === 1 ? 0x86 : 0x87], modReg: a.reg, modRM: b })
      }
      const [r, m] = isReg(a) ? [a, b] : [b, a]
      if (!isReg(r) || !isMem(m)) fail('invalidOperands', { name: ins.mnemonic })
      const s = pairSize(r, m)
      return sizeParts(s, { opcode: [s === 1 ? 0x86 : 0x87], modReg: r.reg, modRM: m })
    }
    case 'test': {
      count(ops, 2)
      if (isRM(a) && isReg(b)) {
        const s = pairSize(a, b)
        return sizeParts(s, { opcode: [s === 1 ? 0x84 : 0x85], modReg: b.reg, modRM: a })
      }
      if (isMem(a) === false && isReg(a) && isMem(b)) {
        const s = pairSize(a, b)
        return sizeParts(s, { opcode: [s === 1 ? 0x84 : 0x85], modReg: a.reg, modRM: b })
      }
      if (isRM(a) && isImm(b)) {
        const s = needSize(a)
        const v = checkImm(b, s)
        if (isAcc(a)) return sizeParts(s, { opcode: [s === 1 ? 0xa8 : 0xa9], imm: { value: v, size: immSizeFor(s) } })
        return sizeParts(s, { opcode: [s === 1 ? 0xf6 : 0xf7], modReg: 0, modRM: a, imm: { value: v, size: immSizeFor(s) } })
      }
      fail('invalidOperands', { name: ins.mnemonic })
    }
    // eslint-disable-next-line no-fallthrough
    case 'push':
    case 'pop': {
      count(ops, 1)
      if (isReg(a)) {
        if (a.reg.size !== 8) fail('pushSize')
        return { opSize: 8, opcode: [op === 'push' ? 0x50 : 0x58], plusReg: a.reg }
      }
      if (isMem(a)) {
        if (a.size && a.size !== 8) fail('pushSize')
        return { opSize: 8, opcode: [op === 'push' ? 0xff : 0x8f], modReg: op === 'push' ? 6 : 0, modRM: a }
      }
      if (op === 'push' && isImm(a)) {
        const v = checkImm(a, 8)
        if (!a.unresolved && !a.reloc && fitsSigned(v, 1)) return { opSize: 8, opcode: [0x6a], imm: { value: v, size: 1 } }
        return { opSize: 8, opcode: [0x68], imm: { value: v, size: 4 } }
      }
      fail('invalidOperands', { name: ins.mnemonic })
    }
    // eslint-disable-next-line no-fallthrough
    case 'jmp':
    case 'call':
    case 'jcc':
    case 'loop': {
      count(ops, 1)
      if (isImm(a)) {
        const target = a.value
        if (op === 'call') return { opcode: [0xe8], rel: { target, size: 4 } }
        if (op === 'loop') return { opcode: [0xe2], rel: { target, size: 1 } }
        const cc = ins.cond?.code ?? 0
        if (op === 'jmp') return longJump ? { opcode: [0xe9], rel: { target, size: 4 } } : { opcode: [0xeb], rel: { target, size: 1 } }
        return longJump ? { opcode: [0x0f, 0x80 + cc], rel: { target, size: 4 } } : { opcode: [0x70 + cc], rel: { target, size: 1 } }
      }
      if ((op === 'jmp' || op === 'call') && isRM(a)) {
        if (rmSize(a) && rmSize(a) !== 8) fail('sizeMismatch')
        return { opSize: 8, opcode: [0xff], modReg: op === 'call' ? 2 : 4, modRM: a }
      }
      fail('invalidOperands', { name: ins.mnemonic })
    }
    // eslint-disable-next-line no-fallthrough
    case 'ret': {
      count(ops, [0, 1])
      if (!a) return { opcode: [0xc3] }
      if (!isImm(a)) fail('invalidOperands', { name: ins.mnemonic })
      if (!a.unresolved && (a.value < 0n || a.value > 0xffffn)) fail('immOutOfRange', { value: a.text, size: 2 })
      return { opcode: [0xc2], imm: { value: a.value, size: 2 } }
    }
    case 'setcc': {
      count(ops, 1)
      if (!isRM(a) || (rmSize(a) ?? 1) !== 1) fail('invalidOperands', { name: ins.mnemonic })
      return { opSize: 1, opcode: [0x0f, 0x90 + ins.cond!.code], modReg: 0, modRM: a }
    }
    case 'cmovcc': {
      count(ops, 2)
      if (!isReg(a) || !isRM(b) || a.reg.size === 1) fail('invalidOperands', { name: ins.mnemonic })
      const s = pairSize(a, b)
      return sizeParts(s, { opcode: [0x0f, 0x40 + ins.cond!.code], modReg: a.reg, modRM: b })
    }
    case 'cbw':
    case 'cwde':
    case 'cdqe':
    case 'cwd':
    case 'cdq':
    case 'cqo': {
      count(ops, 0)
      const size = SIGN_EXT[op]!
      return sizeParts(size, { opcode: [op === 'cbw' || op === 'cwde' || op === 'cdqe' ? 0x98 : 0x99] })
    }
    case 'nop':
      count(ops, 0)
      return { opcode: [0x90] }
    case 'hlt':
      count(ops, 0)
      return { opcode: [0xf4] }
    case 'syscall':
      count(ops, 0)
      return { opcode: [0x0f, 0x05] }
  }
  fail('invalidOperands', { name: ins.mnemonic })
}

function le(value: bigint, size: number): number[] {
  const out: number[] = []
  let v = trunc(value, 8)
  for (let i = 0; i < size; i++) {
    out.push(Number(v & 0xffn))
    v >>= 8n
  }
  return out
}

interface MemEnc {
  mod: number
  rm: number
  sib?: number
  disp: number[]
  x: boolean
  b: boolean
  ripRel: boolean
}

function encodeMem(m: MemOperand): MemEnc {
  if (m.ripRel && !m.base && !m.index) return { mod: 0, rm: 5, disp: [0, 0, 0, 0], x: false, b: false, ripRel: true }
  const disp = m.disp
  if (!m.base && !m.index) {
    // absolute [disp32] needs a SIB byte in 64-bit mode (mod=00 rm=101 would be RIP-relative)
    if (!fitsSigned(disp, 4)) fail('addressTooLarge', { value: m.text })
    return { mod: 0, rm: 4, sib: (0 << 6) | (4 << 3) | 5, disp: le(disp, 4), x: false, b: false, ripRel: false }
  }
  if (!fitsSigned(disp, 4)) fail('addressTooLarge', { value: m.text })
  const scaleBits = { 1: 0, 2: 1, 4: 2, 8: 3 }[m.scale]
  if (!m.base) {
    const idx = m.index!
    return { mod: 0, rm: 4, sib: (scaleBits << 6) | ((idx.index & 7) << 3) | 5, disp: le(disp, 4), x: idx.index >= 8, b: false, ripRel: false }
  }
  const base = m.base
  const low = base.index & 7
  let mod: number
  // An address that is only known after linking always gets a full disp32 (as in NASM).
  if (m.term) mod = 2
  else if (disp === 0n && low !== 5) mod = 0
  else if (fitsSigned(disp, 1)) mod = 1
  else mod = 2
  const dispBytes = mod === 0 ? [] : le(disp, mod === 1 ? 1 : 4)
  if (!m.index && low !== 4) return { mod, rm: low, disp: dispBytes, x: false, b: base.index >= 8, ripRel: false }
  const idxNum = m.index ? m.index.index : 4 // 100 = no index
  return {
    mod,
    rm: 4,
    sib: (scaleBits << 6) | ((idxNum & 7) << 3) | low,
    disp: dispBytes,
    x: !!m.index && m.index.index >= 8,
    b: base.index >= 8,
    ripRel: false,
  }
}

export function encode(ins: EncodeInput, opts: EncodeOptions): Encoded {
  const p = plan(ins, !!opts.longJump)
  const bytes: number[] = []
  if (p.p66) bytes.push(0x66)

  let R = false, X = false, B = false
  let needRex = false
  let high8 = false
  const regs: RegInfo[] = []
  if (p.plusReg) regs.push(p.plusReg)
  if (typeof p.modReg === 'object') regs.push(p.modReg)
  if (p.modRM?.k === 'reg') regs.push(p.modRM.reg)
  for (const r of regs) {
    if (r.size === 1 && r.needsRex) needRex = true
    if (r.high8) high8 = true
  }

  let mem: MemEnc | undefined
  let modrm: number | undefined
  if (p.modRM) {
    const regField = typeof p.modReg === 'object' ? code(p.modReg) : (p.modReg ?? 0)
    R = regField >= 8
    if (p.modRM.k === 'reg') {
      B = p.modRM.reg.index >= 8
      modrm = (3 << 6) | ((regField & 7) << 3) | (code(p.modRM.reg) & 7)
    } else {
      mem = encodeMem(p.modRM)
      X = mem.x
      B = mem.b
      modrm = (mem.mod << 6) | ((regField & 7) << 3) | mem.rm
    }
  }
  if (p.plusReg) B = p.plusReg.index >= 8
  const W = !!p.rexW
  if (W || R || X || B) needRex = true
  if (needRex && high8) fail('highByteWithRex')
  if (needRex) bytes.push(0x40 | (W ? 8 : 0) | (R ? 4 : 0) | (X ? 2 : 0) | (B ? 1 : 0))

  const opc = [...p.opcode]
  if (p.plusReg) opc[opc.length - 1] += code(p.plusReg) & 7
  bytes.push(...opc)
  if (modrm !== undefined) bytes.push(modrm)
  if (mem?.sib !== undefined) bytes.push(mem.sib)
  const dispPos = bytes.length
  const fields: Encoded['fields'] = {}
  if (mem) {
    if (mem.disp.length) fields.disp = { offset: dispPos, size: mem.disp.length }
    bytes.push(...mem.disp)
  }
  if (p.imm) {
    fields.imm = { offset: bytes.length, size: p.imm.size }
    bytes.push(...le(p.imm.value, p.imm.size))
  }

  let jumpOutOfRange = false
  if (p.rel) {
    const end = opts.address + bytes.length + p.rel.size
    const d = p.rel.target - BigInt(end)
    if (!fitsSigned(d, p.rel.size)) {
      if (p.rel.size === 1) jumpOutOfRange = true
      else fail('jumpOutOfRange')
    }
    fields.rel = { offset: bytes.length, size: p.rel.size }
    bytes.push(...le(d, p.rel.size))
  }
  if (mem?.ripRel) {
    const m = p.modRM as MemOperand
    const d = m.disp - BigInt(opts.address + bytes.length)
    if (!fitsSigned(d, 4)) fail('addressTooLarge', { value: m.text })
    bytes.splice(dispPos, 4, ...le(d, 4))
  }
  return { bytes, opSize: p.opSize, jumpOutOfRange, fields }
}
