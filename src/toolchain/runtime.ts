/**
 * The runtime objects every program is linked with, written in assembly:
 *  - crt0.o: `_start`, where the operating system starts the process. It calls `main` and
 *    passes main's return value to the exit system call.
 *  - libc.o: the tiny C library declared in <stdio.h>, <stdlib.h> and <unistd.h>.
 */
export const CRT0_NAME = 'crt0.o'
export const LIBC_NAME = 'libc.o'

export const CRT0_SOURCE = `; crt0.o - C runtime start-up code (hand-written assembly)
; The operating system starts the process at _start, not at main.
default rel
global _start
extern main

section .text
_start:
    xor edi, edi          ; argc = 0 (the simulator passes no arguments)
    xor esi, esi          ; argv = NULL
    call main             ; int main(void)
    mov edi, eax          ; exit code = return value of main
    mov eax, 60           ; syscall 60 = exit
    syscall
`

export const LIBC_SOURCE = `; libc.o - the simulator's tiny C library (hand-written assembly)
; Arguments arrive in rdi, rsi, rdx (System V calling convention), results go to rax.
default rel
global write, exit, putchar, puts, print_int

section .text
; long write(int fd, const char *buf, long count)
write:
    mov eax, 1            ; syscall 1 = write (rdi, rsi, rdx already hold the arguments)
    syscall
    ret

; void exit(int status)
exit:
    mov eax, 60           ; syscall 60 = exit, status in rdi
    syscall

; int putchar(int c)
putchar:
    push rbp
    mov rbp, rsp
    sub rsp, 16
    mov [rbp-1], dil      ; the character is written from memory
    mov edi, 1            ; fd 1 = stdout
    lea rsi, [rbp-1]
    mov edx, 1
    mov eax, 1
    syscall
    movzx eax, byte [rbp-1]
    mov rsp, rbp
    pop rbp
    ret

; int puts(const char *s): writes s and a newline
puts:
    push rbp
    mov rbp, rsp
    mov rsi, rdi
    xor edx, edx          ; rdx = strlen(s)
.len:
    cmp byte [rsi+rdx], 0
    je .write
    inc rdx
    jmp .len
.write:
    mov edi, 1
    mov eax, 1
    syscall
    mov edi, 10           ; '\\n'
    call putchar
    mov eax, 0
    mov rsp, rbp
    pop rbp
    ret

; void print_int(long n): writes n in decimal
print_int:
    push rbp
    mov rbp, rsp
    sub rsp, 32
    mov rax, rdi
    lea rsi, [rbp-1]      ; digits are written backwards, ending at rbp-1
    mov ecx, 10
    test rax, rax
    jns .digits
    neg rax               ; work with the absolute value
.digits:
    xor edx, edx
    div rcx               ; rax = n / 10, rdx = n % 10
    add dl, '0'
    mov [rsi], dl
    dec rsi
    test rax, rax
    jnz .digits
    test rdi, rdi
    jns .out
    mov byte [rsi], '-'
    dec rsi
.out:
    inc rsi               ; first character
    mov rdx, rbp
    sub rdx, rsi          ; length = rbp - rsi
    mov edi, 1
    mov eax, 1
    syscall
    mov rsp, rbp
    pop rbp
    ret
`
