import { describe, expect, it } from 'vitest'
import { assemble } from '../assembler'
import { parseNumber } from '../lexer'
import { toHex } from './nasm'

const bytes = (src: string) => {
  const r = assemble(src)
  expect(r.errors).toEqual([])
  return toHex(r.program!.sections.text.bytes)
}
const errorOf = (src: string) => {
  const r = assemble(src)
  expect(r.program).toBeNull()
  return r.errors[0]
}

describe('number formats', () => {
  it.each([
    ['42', 42n], ['0x1F', 31n], ['1Fh', 31n], ['0FFh', 255n], ['0b101', 5n], ['101b', 5n],
    ['0o17', 15n], ['17q', 15n], ['0dh', 13n], ['0ah', 10n], ['0bh', 11n], ['0b1h', 0xb1n], ['99d', 99n], ['0x7FFF_F000', 0x7ffff000n], ['0d99', 99n],
  ])('%s', (text, v) => expect(parseNumber(text)).toBe(v))

  it('rejects bad numbers', () => expect(() => parseNumber('12xz')).toThrow())

  it('character literals are little-endian', () => {
    expect(bytes("mov eax, 'AB'")).toBe('b8 41 42 00 00')
  })
})

// Hand-checked against the Intel SDM opcode tables; independent of an installed nasm.
describe('encoder reference vectors', () => {
  it.each([
    ['mov rax, rbx', '48 89 d8'],
    ['mov eax, 1', 'b8 01 00 00 00'],
    ['mov rax, -1', '48 c7 c0 ff ff ff ff'],
    ['mov qword [rbx], 5', '48 c7 03 05 00 00 00'],
    ['mov rax, [rbp+0x10]', '48 8b 45 10'],
    ['mov rax, [rsp]', '48 8b 04 24'],
    ['mov rax, [0x8000]', '48 8b 04 25 00 80 00 00'],
    ['lea rax, [rbx+rcx*4+8]', '48 8d 44 8b 08'],
    ['add rax, 5', '48 83 c0 05'],
    ['add rax, 0x1000', '48 05 00 10 00 00'],
    ['xor eax, eax', '31 c0'],
    ['push rbp', '55'],
    ['push r12', '41 54'],
    ['pop rbp', '5d'],
    ['syscall', '0f 05'],
    ['ret', 'c3'],
    ['shl rax, 1', '48 d1 e0'],
    ['sete al', '0f 94 c0'],
    ['mov sil, 1', '40 b6 01'],
    ['mov ah, al', '88 c4'],
  ])('%s → %s', (src, hex) => expect(bytes(src)).toBe(hex))

  it('chooses short jumps when the target is near and long ones otherwise', () => {
    const r = assemble('a: jmp a\njmp b\ntimes 300 db 0\nb: nop')
    expect(r.errors).toEqual([])
    const [j1, j2] = r.program!.instructions
    expect(toHex(j1.bytes)).toBe('eb fe')
    expect(j2.bytes[0]).toBe(0xe9)
  })
})

describe('layout and symbols', () => {
  const src = `
section .data
hello: db 'Hello', 13, 10
len: equ $ - hello
section .bss
buf: resq 2
section .text
global _start
_start:
  mov rsi, hello
  mov rdx, len
.l: dec rdx
  jnz .l
`
  it('places sections and resolves equ / $ / local labels', () => {
    const r = assemble(src)
    expect(r.errors).toEqual([])
    const p = r.program!
    expect(p.sections.text.start).toBe(0x401000)
    expect(p.sections.data.start).toBe(0x402000)
    expect(p.sections.bss.start).toBe(0x402010)
    const sym = (n: string) => p.symbols.find((s) => s.name === n)!.value
    expect(sym('hello')).toBe(0x402000n)
    expect(sym('len')).toBe(7n)
    expect(sym('buf')).toBe(0x402010n)
    expect(sym('_start.l')).toBeDefined()
    expect(p.entry).toBe(0x401000)
    expect(Array.from(p.sections.data.bytes)).toEqual([72, 101, 108, 108, 111, 13, 10])
  })

  it('maps source lines to addresses and back', () => {
    const r = assemble(src)
    const ins = r.program!.instructions[1]
    expect(ins.text).toBe('mov rdx, len')
    expect(r.sourceMap.addressToLine.get(ins.address)).toBe(ins.line)
    expect(r.sourceMap.lineToAddress.get(ins.line)).toBe(ins.address)
    expect(r.sourceMap.lineToInstr.get(ins.line)).toBe(1)
  })
})

describe('errors point at the offending line', () => {
  it('unsupported instruction', () => {
    expect(errorOf('nop\ncpuid')).toEqual({ line: 2, code: 'unsupportedInstruction', params: { name: 'cpuid' } })
  })
  it('typo gets a suggestion', () => {
    expect(errorOf('movv rax, 1')).toMatchObject({ code: 'unknownInstruction', params: { suggestion: 'mov' } })
  })
  it('AH cannot be combined with a REX prefix', () => {
    expect(errorOf('mov ah, sil').code).toBe('highByteWithRex')
    expect(errorOf('mov ah, r8b').code).toBe('highByteWithRex')
  })
  it('64-bit immediates only for mov', () => {
    expect(errorOf('add rax, 0x100000000').code).toBe('imm64NotAllowed')
    expect(errorOf('add rax, 0xFFFFFFFF').code).toBe('imm64NotAllowed')
  })
  it('memory operand needs a size', () => {
    expect(errorOf('mov [rbx], 5').code).toBe('sizeUnknown')
    expect(errorOf('inc [rbx]').code).toBe('sizeUnknown')
  })
  it('operand size mismatch', () => expect(errorOf('mov rax, ebx').code).toBe('sizeMismatch'))
  it('MASM ptr syntax', () => expect(errorOf('mov qword ptr [rbx], 1').code).toBe('ptrKeyword'))
  it('undefined symbol', () => expect(errorOf('jmp nowhere')).toMatchObject({ code: 'undefinedSymbol', params: { name: 'nowhere' } }))
  it('duplicate label', () => expect(errorOf('a: nop\na: nop')).toMatchObject({ line: 2, code: 'duplicateSymbol' }))
  it('32-bit addressing', () => expect(errorOf('mov rax, [ebx]').code).toBe('address32'))
  it('bad scale', () => expect(errorOf('mov rax, [rbx*6]').code).toBe('badAddress'))
  it('movzx from 32 bit', () => expect(errorOf('movzx rax, ebx').code).toBe('movzx32'))
  it('immediate too large for byte', () => expect(errorOf('mov al, 256').code).toBe('immOutOfRange'))
  it('instruction in .data', () => expect(errorOf('section .data\nmov rax, 1').code).toBe('instrOutsideText'))
  it('unsupported directive', () => expect(errorOf('org 0x100\nnop').code).toBe('unsupportedDirective'))
  it('extern needs the linker', () => expect(errorOf('extern printf\nnop').code).toBe('externNeedsLinker'))
  it('reports multiple errors', () => {
    expect(assemble('cpuid\nnop\nfoo rax').errors.map((e) => e.line)).toEqual([1, 3])
  })
})
