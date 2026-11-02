import { describe, expect, it } from 'vitest'
import { assemble } from '../assembler'
import { hasNasm, nasmImage, toHex } from './nasm'

const PROGRAMS: Record<string, string> = {
  hello: `
BITS 64
global _start
section .data
hello: db 'Hello, World!', 13, 10
len: equ $ - hello
section .text
_start:
    mov rax, 1
    mov rdi, 1
    mov rsi, hello
    mov rdx, len
    syscall
    mov rax, 60
    xor edi, edi
    syscall
`,
  shortAndLongJumps: `
section .text
start:
    xor ecx, ecx
.top:
    inc rcx
    cmp rcx, 10
    jl .top
    jmp far_away
    times 200 db 0x90
far_away:
    jne start
    loop far_away
    call fn
    jmp done
fn:
    ret
done:
    hlt
`,
  dataKinds: `
section .data
a: db 1, 2, 3, -1, 'xy', 0
b: dw 0x1234, 'ab', 'abc'
c: dd 0xDEADBEEF, -2
d: dq 0x1122334455667788, a, d
e: times 4 db 0xAA
nums: db 0dh, 0ah, 0bh, 1bh, 0x1b, 0b101, 101b, 0d99, 0b1h, 0ffh, 0h, 10q, 0q17, 0o17, 17o, 99d, 0y11, 11y, 0x1_0, 1_0h
msg: db \`tab\\there\\n\`, 0
section .bss
buf: resb 16
q: resq 2
section .text
    mov rax, [d]
    mov rbx, buf
    lea rcx, [q + 8]
    mov qword [q], 7
    movzx eax, byte [a + 2]
    mov rdx, (c - a) * 2
    mov eax, 'AB'
`,
  relAddressing: `
default rel
section .data
x: dq 42
y: dd 7
section .text
    mov rax, [x]
    lea rsi, [y]
    mov eax, [abs y]
    add qword [x], 1
    mov rcx, [rel x + 4]
    mov rdx, [0x8000]
`,
  stackFrame: `
section .text
main:
    push 3
    call f
    add rsp, 8
    hlt
f:
    push rbp
    mov rbp, rsp
    mov rax, [rbp+0x10]
    mov rsp, rbp
    pop rbp
    ret
`,
}

describe.skipIf(!hasNasm)('whole programs match nasm', () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    it(name, () => {
      const res = assemble(src)
      expect(res.errors).toEqual([])
      const p = res.program!
      const ref = nasmImage(src, p)
      expect(toHex(p.sections.text.bytes)).toBe(toHex(ref.text))
      expect(toHex(p.sections.data.bytes)).toBe(toHex(ref.data))
    })
  }
})

describe.skipIf(!hasNasm)('label immediates match nasm', () => {
  const src = `
section .data
v: dq 1
section .text
    push v
    add rax, v
    cmp rbx, v
    mov ecx, v
    mov qword [rbx], v
    imul rax, rbx, v
    mov rax, v - 0x402000
`
  it('label immediates', () => {
    const res = assemble(src)
    expect(res.errors).toEqual([])
    expect(toHex(res.program!.sections.text.bytes)).toBe(toHex(nasmImage(src, res.program!).text))
  })
})
