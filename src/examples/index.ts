/** Built-in example programs (lecture style, NASM syntax). */
export interface Example {
  id: string
  title: string
  source: string
}

const hello = `; Hello World with the Linux system calls write and exit
BITS 64
global _start

section .data
hello:  db 'Hello, World!', 13, 10   ; text + CR LF
len:    equ $ - hello                ; $ = current address → length = 15

section .text
_start:
    mov rax, 1          ; system call number 1 = write
    mov rdi, 1          ; 1st argument: file descriptor 1 = stdout
    mov rsi, hello      ; 2nd argument: address of the text
    mov rdx, len        ; 3rd argument: number of bytes
    syscall             ; → text appears in the console

    mov rax, 60         ; system call number 60 = exit
    mov rdi, 0          ; exit code 0
    syscall
`

const subregs = `; Sub-registers: AL, AH, AX, EAX are all views of RAX.
; Watch the upper bits of RAX after every step!
BITS 64
global _start

section .text
_start:
    mov rax, -1         ; RAX = 0xFFFFFFFFFFFFFFFF (all 64 bits set)
    mov eax, 1          ; 32-bit write: upper 32 bits become 0!
    mov rax, -1
    mov ax, 2           ; 16-bit write: bits 63..16 stay unchanged
    mov al, 3           ; 8-bit write: only bits 7..0 change
    mov ah, 4           ; AH = bits 15..8
    mov r8, -1
    mov r8d, 5          ; same rule for R8..R15
    mov r9, -1
    mov r9b, 6          ; R9B = lowest byte of R9
    xor eax, eax        ; common idiom: clears all of RAX

    mov rax, 60
    xor edi, edi
    syscall
`

const addressing = `; Addressing modes: mov reads memory, lea only computes the address.
BITS 64
global _start

section .data
array:  dq 10, 20, 30, 40     ; 4 quadwords (8 bytes each)

section .bss
result: resq 2

section .text
_start:
    mov rbx, array          ; RBX = address of array (an immediate)
    mov rax, [array]        ; displacement:  [0x402000]         → 10
    mov rax, [rbx]          ; base:          [rbx]              → 10
    mov rax, [rbx + 8]      ; base + disp:   [rbx + 8]          → 20
    mov rcx, 2
    mov rax, [rbx + rcx*8]  ; base + index*scale                 → 30
    mov rax, [array + rcx*8 + 8] ; disp + index*scale + disp     → 40

    lea rdx, [rbx + rcx*8]  ; lea: RDX = address only, no memory read
    mov rax, [rdx]          ; now read from that address        → 30

    lea rsi, [rcx + rcx*4]  ; lea as a calculator: RSI = 5 * RCX = 10
    mov [result], rsi       ; store into .bss
    mov qword [result + 8], 7 ; size specifier needed for imm → mem

    mov rax, 60
    xor edi, edi
    syscall
`

const sumArray = `; Sum the elements of an array with cmp / jl.
BITS 64
global _start

section .data
numbers: dq 3, 1, 4, 1, 5, 9, 2, 6
count:   equ ($ - numbers) / 8     ; number of elements = 8

section .bss
sum:     resq 1

section .text
_start:
    xor eax, eax            ; RAX = running sum = 0
    xor ecx, ecx            ; RCX = index i = 0
.loop:
    add rax, [numbers + rcx*8]  ; sum += numbers[i]
    inc rcx                 ; i++
    cmp rcx, count          ; compare i with count
    jl .loop                ; jump while i < count (signed)

    mov [sum], rax          ; store the result (31) in memory

    mov rdi, rax            ; exit code = sum
    mov rax, 60
    syscall
`

const signedUnsigned = `; Signed vs. unsigned: the same bits, different interpretations.
BITS 64
global _start

section .text
_start:
    mov rax, -1             ; 0xFFFF...FF: unsigned huge, signed -1
    mov rbx, 1
    xor ecx, ecx
    xor edx, edx

    cmp rax, rbx            ; flags: CF=0 (unsigned no borrow), SF/OF → signed -1 < 1
    ja .above               ; unsigned: 0xFFFF...FF > 1 → taken
    jmp .test_signed
.above:
    mov rcx, 1              ; RCX = 1 → "above" was true

.test_signed:
    cmp rax, rbx
    jg .greater             ; signed: -1 > 1 is false → not taken
    jmp .shifts
.greater:
    mov rdx, 1

.shifts:
    mov rsi, -16
    mov rdi, rsi
    shr rsi, 2              ; logical shift: fills with 0 → huge positive
    sar rdi, 2              ; arithmetic shift: keeps sign → -4

    ; CF vs OF on 8-bit additions
    mov al, 0xFF
    add al, 1               ; 255 + 1: CF=1 (unsigned overflow), OF=0
    mov al, 0x7F
    add al, 1               ; 127 + 1: CF=0, OF=1 (signed overflow)

    mov rax, 60
    xor edi, edi
    syscall
`

const mulDiv = `; mul and div use the fixed register pair RDX:RAX.
BITS 64
global _start

section .text
_start:
    mov rax, 0x100000000    ; 2^32
    mov rbx, 0x100000000    ; 2^32
    mul rbx                 ; RDX:RAX = 2^64 → RDX = 1, RAX = 0, CF=OF=1

    mov rax, 100
    mov rbx, 7
    mul rbx                 ; RDX:RAX = 700 → RDX = 0, CF=OF=0

    xor edx, edx            ; IMPORTANT: clear RDX before div!
    mov rcx, 9
    div rcx                 ; 700 / 9 → RAX = 77 (quotient), RDX = 7 (remainder)

    mov rax, -100
    mov rdx, -1             ; sign-extend RAX into RDX for idiv
    mov rcx, 7
    idiv rcx                ; -100 / 7 → RAX = -14, RDX = -2

    imul rax, rcx, 3        ; 3-operand form: RAX = RCX * 3 = 21

    mov rax, 60
    xor edi, edi
    syscall
`

const recursion = `; Recursive sum S(n) = n + S(n-1), S(0) = 0.
; Watch the stack grow with every call and shrink with every ret.
BITS 64
global _start

section .text
_start:
    mov rdi, 4              ; n = 4
    call sum                ; RAX = S(4) = 10
    mov rdi, rax            ; exit code = 10
    mov rax, 60
    syscall

; sum(n): argument in RDI, result in RAX
sum:
    cmp rdi, 0
    jne .recurse
    xor eax, eax            ; base case: S(0) = 0
    ret
.recurse:
    push rdi                ; save n on the stack
    dec rdi                 ; n - 1
    call sum                ; RAX = S(n-1)
    pop rdi                 ; restore n
    add rax, rdi            ; RAX = n + S(n-1)
    ret
`

const stackFrame = `; Function with a stack frame: arguments on the stack, accessed via RBP.
BITS 64
global _start

section .text
_start:
    push 30                 ; 2nd argument  → [rbp+0x18]
    push 12                 ; 1st argument  → [rbp+0x10]
    call add_args           ; pushes the return address → [rbp+0x08]
    add rsp, 16             ; caller removes the arguments

    mov rdi, rax            ; exit code = 42
    mov rax, 60
    syscall

add_args:
    push rbp                ; save the caller's RBP     → [rbp]
    mov rbp, rsp            ; RBP = base of this frame
    sub rsp, 8              ; space for one local variable [rbp-8]

    mov rax, [rbp+0x10]     ; 1st argument
    add rax, [rbp+0x18]     ; + 2nd argument
    mov [rbp-8], rax        ; store in the local variable

    mov rax, [rbp-8]
    mov rsp, rbp            ; free the local variables
    pop rbp                 ; restore the caller's RBP
    ret                     ; jump back to the return address
`

export const EXAMPLES: Example[] = [
  { id: 'hello', title: '1 · Hello World (write + exit)', source: hello },
  { id: 'subregs', title: '2 · Sub-registers (RAX / EAX / AX / AL)', source: subregs },
  { id: 'addressing', title: '3 · Addressing modes: mov vs. lea', source: addressing },
  { id: 'sum', title: '4 · Sum an array (cmp / jl loop)', source: sumArray },
  { id: 'signed', title: '5 · Signed vs. unsigned (ja/jg, shr/sar)', source: signedUnsigned },
  { id: 'muldiv', title: '6 · mul / div with RDX:RAX', source: mulDiv },
  { id: 'recursion', title: '7 · Recursive sum with call / ret', source: recursion },
  { id: 'frame', title: '8 · Stack frame (push rbp / mov rbp, rsp)', source: stackFrame },
]
