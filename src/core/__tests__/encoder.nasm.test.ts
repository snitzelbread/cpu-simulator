import { describe, expect, it } from 'vitest'
import { assemble } from '../assembler'
import { hasNasm, nasmText, toHex } from './nasm'

/** One instruction per entry; each is compared byte-for-byte with nasm. */
const CASES = `
mov rax, rbx
mov eax, ebx
mov ax, bx
mov al, bl
mov ah, bh
mov sil, dil
mov r8b, al
mov r15, r8
mov r9d, r10d
mov rax, 5
mov rax, -1
mov rax, 0x7FFFFFFF
mov rax, 0x80000000
mov rax, 0xFFFFFFFF
mov rax, 0x100000000
mov rax, 0x123456789ABCDEF0
mov rax, -0x80000000
mov rax, -0x80000001
mov eax, 1
mov ax, 0x1234
mov al, 2
mov ah, 0xFF
mov r12, 7
mov r12d, 7
mov qword [rbx], 5
mov dword [rbx], 5
mov word [rbx], 5
mov byte [rbx], 5
mov [rbx], rax
mov rax, [rbx]
mov rax, [rsp]
mov rax, [rbp]
mov rax, [r12]
mov rax, [r13]
mov rax, [rbx+8]
mov rax, [rbx-8]
mov rax, [rbx+0x100]
mov rax, [rbp+0x10]
mov rax, [rbp-8]
mov rax, [0x8000]
mov rax, [rcx*8]
mov rax, [rcx*2]
mov rax, [rcx*4+0x2000]
mov rax, [0x2000 + rbx + rcx*2]
mov rax, [rbx+rcx]
mov rax, [rbx+rcx*8+16]
mov rax, [rsp+rax]
mov rax, [rax+rsp]
mov rax, [r8+r9*4]
mov rax, [rbp+r12]
mov rax, [r13+rax*2]
mov rax, [rax*3]
mov rax, [rcx*5+8]
mov [rsp+8], rdi
mov byte [r8+1], 0x41
movzx eax, byte [rbx]
movzx rax, al
movzx eax, bl
movzx ax, bl
movzx eax, word [rbx]
movzx rcx, word [rbx+2]
movsx rax, al
movsx eax, byte [rbx]
movsx rax, word [rbx]
movsxd rax, ebx
cbw
cwde
movsxd rax, eax
movsx eax, ax
movsx ax, al
movsx eax, al
movsxd rcx, eax
cdqe
cwd
cdq
cqo
shl eax, cl
sar rax, cl
shr r8d, cl
imul eax, ecx
imul rax, rcx, 24
movzx eax, al
movsx eax, word [rbp-2]
mov dword [rbp-4], edi
mov qword [rbp-16], rsi
lea rax, [rbp-48]
movsxd rax, dword [rbx]
lea rax, [rbx+rcx*4+8]
lea eax, [rbx+1]
lea rsi, [0x402000]
lea rdi, [rsp+16]
xchg rax, rbx
xchg rbx, rax
xchg rbx, rcx
xchg eax, ebx
xchg al, bl
xchg rax, r8
xchg [rbx], rax
xchg rax, [rbx]
push rax
push r12
push qword [rbx]
push 5
push 0x1000
push -1
pop rbx
pop r15
pop qword [rbx]
add rax, rbx
add eax, ebx
add al, bl
add rax, [rbx]
add [rbx], rax
add rax, 5
add rax, -5
add rax, 0x1000
add rbx, 0x1000
add eax, 0x1000
add al, 5
add bl, 5
add ax, 5
add ax, 0x1000
add cx, 0x1000
add qword [rbx], 1
add dword [rbx], 0x1000
add byte [rbx], 0xFF
sub rax, rbx
sub rsp, 16
sub rsp, 0x100
adc rax, rbx
adc rax, 0
sbb rdx, rcx
sbb al, 1
and rax, 0xFF
and eax, 0xFFFF
and al, 0x0F
and rbx, -16
or rax, rbx
or ecx, 1
xor eax, eax
xor rax, rax
xor r8d, r8d
cmp rax, rbx
cmp rax, 0
cmp al, 'A'
cmp qword [rbx], 0
cmp rax, [rbx+8]
cmp eax, 1000
test rax, rax
test rax, 1
test eax, 0x80
test al, 1
test bl, 1
test rbx, 0x100
test [rbx], al
test qword [rbx], 1
inc rax
inc eax
inc al
inc qword [rbx]
inc r10
dec rcx
dec byte [rbx]
neg rax
neg eax
not rax
not byte [rbx]
mul rbx
mul ebx
mul bl
mul qword [rbx]
imul rbx
imul rax, rbx
imul eax, ebx
imul rax, [rbx]
imul rax, rbx, 10
imul rax, rbx, 1000
imul rax, 10
imul ax, bx, 3
div rbx
div ecx
div bl
div qword [rbx]
idiv rcx
idiv dword [rbx]
shl rax, 1
shl rax, 4
shl rax, cl
shl eax, 31
shl al, 3
sal rax, 2
shr rax, 1
shr rax, 63
shr rbx, cl
sar rax, 1
sar rax, 63
sar byte [rbx], 2
rol rax, 1
rol rax, 8
rol eax, cl
ror rax, 4
ror word [rbx], 1
sete al
setne bl
setl sil
setg byte [rbx]
setb r9b
cmove rax, rbx
cmovl eax, ecx
cmovge rax, [rbx]
cmovz r8, r9
jmp rax
jmp qword [rbx]
call rax
call qword [rbx+8]
ret
ret 16
nop
hlt
syscall
mov rax, [rel 0x402000]
mov ah, al
add ah, 3
mov ch, [rbx]
`.trim().split('\n')

describe.skipIf(!hasNasm)('encoder matches nasm', () => {
  for (const line of CASES) {
    it(line, () => {
      const res = assemble(line)
      expect(res.errors).toEqual([])
      const ours = Array.from(res.program!.sections.text.bytes)
      expect(toHex(ours)).toBe(toHex(nasmText(line, res.program!)))
    })
  }
})
