import { describe, expect, it } from 'vitest'
import { assemble } from '../core/assembler'
import { Machine } from '../core/cpu/machine'
import { hasNasm, nasmImage, toHex } from '../core/__tests__/nasm'
import { reg } from '../core/__tests__/helpers'
import { EXAMPLES } from './index'

const M64 = (v: bigint) => v & 0xffffffffffffffffn

function runExample(id: string) {
  const ex = EXAMPLES.find((e) => e.id === id)!
  const r = assemble(ex.source)
  expect(r.errors).toEqual([])
  const m = new Machine(r.program!)
  m.run({ limit: 10_000 })
  expect(m.status).toBe('exited')
  return m
}

const sym = (m: Machine, name: string) => Number(m.program.symbols.find((s) => s.name === name)!.value)
const text = (m: Machine) => m.console.map((c) => new TextDecoder().decode(new Uint8Array(c.bytes))).join('')

describe('example programs: final state', () => {
  it('1 hello world', () => {
    const m = runExample('hello')
    expect(text(m)).toBe('Hello, World!\r\n')
    expect(m.exitCode).toBe(0)
  })
  it('2 sub-registers', () => {
    const m = runExample('subregs')
    expect(reg(m, 'rax')).toBe(60n) // last value before exit
    expect(reg(m, 'r8')).toBe(5n)
    expect(reg(m, 'r9')).toBe(0xffffffffffffff06n)
    // replay up to `mov ah, 4`
    m.history.length = 0
    const m2 = new Machine(m.program)
    for (let i = 0; i < 6; i++) m2.step()
    expect(reg(m2, 'rax')).toBe(0xffffffffffff0403n)
  })
  it('3 addressing modes', () => {
    const m = runExample('addressing')
    const res = sym(m, 'result')
    expect(m.mem.read(res, 8)).toBe(10n)
    expect(m.mem.read(res + 8, 8)).toBe(7n)
    expect(reg(m, 'rdx')).toBe(BigInt(sym(m, 'array') + 16))
    const reads = m.history.slice(0, 10).filter((t) => t.instr.op === 'mov' && t.mem.some((x) => x.kind === 'read' && !x.fetch))
    expect(reads.map((t) => t.regs[0].after)).toEqual([10n, 10n, 20n, 30n, 40n, 30n])
  })
  it('4 sum array', () => {
    const m = runExample('sum')
    expect(m.mem.read(sym(m, 'sum'), 8)).toBe(31n)
    expect(m.exitCode).toBe(31)
  })
  it('5 signed vs unsigned', () => {
    const m = runExample('signed')
    m.stepBack() // undo the exit syscall (syscall overwrites RCX with the return address)
    expect(reg(m, 'rcx')).toBe(1n)
    expect(reg(m, 'rdx')).toBe(0n)
    expect(reg(m, 'rsi')).toBe(M64(-16n) >> 2n)
    expect(m.history.find((t) => t.instr.op === 'sar')!.regs[0].after).toBe(M64(-4n))
    const adds = m.history.filter((t) => t.instr.op === 'add')
    expect(adds[0].flagsAfter).toMatchObject({ CF: true, OF: false })
    expect(adds[1].flagsAfter).toMatchObject({ CF: false, OF: true })
  })
  it('6 mul / div', () => {
    const m = runExample('muldiv')
    const mul1 = m.history.find((t) => t.instr.op === 'mul')!
    expect(mul1.regs.map((r) => r.after)).toEqual([0n, 1n])
    expect(mul1.flagsAfter).toMatchObject({ CF: true, OF: true })
    const div = m.history.find((t) => t.instr.op === 'div')!
    expect(div.regs.map((r) => r.after)).toEqual([77n, 7n])
    const idiv = m.history.find((t) => t.instr.op === 'idiv')!
    expect(idiv.regs.map((r) => r.after)).toEqual([M64(-14n), M64(-2n)])
    expect(reg(m, 'rdi')).toBe(0n)
  })
  it('7 recursion', () => {
    const m = runExample('recursion')
    expect(m.exitCode).toBe(10)
    expect(m.regs[4]).toBe(BigInt(m.program.stackTop))
    const minRsp = m.history.reduce((a, t) => (t.regs.find((r) => r.index === 4)?.after ?? a) < a ? t.regs.find((r) => r.index === 4)!.after : a, m.regs[4])
    expect(BigInt(m.program.stackTop) - minRsp).toBe(9n * 8n) // 5 return addresses + 4 saved values of n
  })
  it('8 stack frame', () => {
    const m = runExample('frame')
    expect(m.exitCode).toBe(42)
    expect(m.regs[4]).toBe(BigInt(m.program.stackTop))
    expect(reg(m, 'rbp')).toBe(0n)
  })
})

describe.skipIf(!hasNasm)('example programs match nasm byte-for-byte', () => {
  for (const ex of EXAMPLES) {
    it(ex.id, () => {
      const r = assemble(ex.source)
      const ref = nasmImage(ex.source, r.program!)
      expect(toHex(r.program!.sections.text.bytes)).toBe(toHex(ref.text))
      expect(toHex(r.program!.sections.data.bytes)).toBe(toHex(ref.data))
    })
  }
})
