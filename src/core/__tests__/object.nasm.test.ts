import { describe, expect, it } from 'vitest'
import { assembleObject } from '../assembler'
import { checkAgainstNasm as check } from './elf'
import { hasNasm } from './nasm'

const PROGRAMS: Record<string, string> = {
  'extern calls, rip-relative data, abs data, imm64': `default rel
extern foo, bar
global main
section .text
main:
  call foo
  mov eax, [bar]
  lea rax, [msg]
  mov rax, msg
  mov edi, [rbx+msg]
  jmp .l
.l:
  call main
  ret
section .data
msg: db 1,2,3
p: dq msg
q: dd foo
section .bss
b: resq 1
`,
  'jumps: short, near, to extern': `extern ext
global f
section .text
f:
  jz .a
  jmp ext
  je ext
${'  nop\n'.repeat(130)}.a:
  jmp f
  ret
`,
  'immediates with symbols': `default rel
extern e
section .text
g:
  mov eax, x
  push x
  mov rax, e
  add rax, x
  mov qword [rel y], 5
  mov dword [y], e
  cmp byte [x + 3], 1
  lea rsi, [y + 8]
section .data
x: dd 1, 2
y: dq 0
z: dq y + 4, e + 8, z - x
section .bss
w: resd 4
`,
  'compiler-style function': `default rel
extern puts
global main
section .text
main:
  push rbp
  mov rbp, rsp
  sub rsp, 16
  mov dword [rbp-4], 7
  mov eax, [counter]
  add eax, [rbp-4]
  mov [counter], eax
  lea rax, [str0]
  mov rdi, rax
  call puts
  mov eax, [counter]
  cdq
  mov ecx, 3
  idiv ecx
  mov rsp, rbp
  pop rbp
  ret
section .data
counter: dd 15
str0: db "hi", 0
section .bss
buf: resb 10
`,
}

describe.skipIf(!hasNasm)('object files match nasm -f elf64', () => {
  for (const [name, src] of Object.entries(PROGRAMS)) it(name, () => check(src))
})

describe('object files', () => {
  it('leaves relocation fields as 0 and records extern symbols as UND', () => {
    const o = assembleObject('extern f\nsection .text\ncall f\n', 'a.o').object!
    expect(Array.from(o.sections.text.bytes)).toEqual([0xe8, 0, 0, 0, 0])
    expect(o.relocations[0]).toMatchObject({ offset: 1, type: 'R_X86_64_PC32', addend: -4n, target: { kind: 'extern', name: 'f' }, instr: 0, operand: 0 })
    expect(o.symbols).toContainEqual(expect.objectContaining({ name: 'f', section: 'UND' }))
  })
  it('reports global symbols that are never defined', () => {
    expect(assembleObject('global nope\nsection .text\nret\n', 'a.o').errors[0].code).toBe('globalUndefined')
  })
  it('rejects expressions that are not one address plus a constant', () => {
    expect(assembleObject('extern a, b\nsection .text\nmov rax, a + b\n', 'a.o').errors[0].code).toBe('badRelocation')
  })
  it('extern cannot also be defined', () => {
    expect(assembleObject('extern a\nsection .text\na: ret\n', 'a.o').errors[0].code).toBe('externDefined')
  })
})
