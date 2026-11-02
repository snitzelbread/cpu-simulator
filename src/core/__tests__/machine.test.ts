import { describe, expect, it } from 'vitest'
import { CONDITIONS, evalCondition } from '../isa'
import { flagStr, load, reg, run } from './helpers'

describe('sub-register write semantics', () => {
  it('32-bit writes zero-extend, 8/16-bit writes merge', () => {
    const m = run(`
      mov rax, -1
      mov eax, 1
      mov rbx, -1
      mov bx, 2
      mov rcx, -1
      mov cl, 3
      mov rdx, -1
      mov dh, 4
    `)
    expect(reg(m, 'rax')).toBe(1n)
    expect(reg(m, 'rbx')).toBe(0xffffffffffff0002n)
    expect(reg(m, 'rcx')).toBe(0xffffffffffffff03n)
    expect(reg(m, 'rdx')).toBe(0xffffffffffff04ffn)
  })

  it('records zero-extension in the trace', () => {
    const m = load('mov rax, -1\nmov eax, 1\nhlt')
    m.step()
    const t = m.step()!
    expect(t.regs[0]).toMatchObject({ name: 'eax', zeroExtended: true, before: 0xffffffffffffffffn, after: 1n })
  })

  it('extended registers and their views', () => {
    const m = run('mov r8, -1\nmov r8d, 5\nmov r9, -1\nmov r9w, 6\nmov r10, -1\nmov r10b, 7\nmov sil, 0x11')
    expect(reg(m, 'r8')).toBe(5n)
    expect(reg(m, 'r9')).toBe(0xffffffffffff0006n)
    expect(reg(m, 'r10')).toBe(0xffffffffffffff07n)
    expect(reg(m, 'rsi')).toBe(0x11n)
  })

  it('xor eax, eax clears the whole register', () => {
    expect(reg(run('mov rax, -1\nxor eax, eax'), 'rax')).toBe(0n)
  })

  it('lea and movzx with 32-bit destination zero-extend', () => {
    const m = run('mov rax, -1\nlea eax, [rbx+5]\nmov rcx, -1\nmovzx ecx, byte [msg]\nsection .data\nmsg: db 0x80')
    expect(reg(m, 'rax')).toBe(5n)
    expect(reg(m, 'rcx')).toBe(0x80n)
  })
})

describe('flags: add / sub / cmp / neg', () => {
  it('0x7F + 1 in 8 bit sets OF and SF but not CF', () => {
    const m = run('mov al, 0x7F\nadd al, 1')
    expect(reg(m, 'al')).toBe(0x80n)
    expect(flagStr(m)).toBe('CF=0 PF=0 ZF=0 SF=1 OF=1')
  })
  it('0x7FFF_FFFF_FFFF_FFFF + 1 overflows signed', () => {
    const m = run('mov rax, 0x7FFFFFFFFFFFFFFF\nadd rax, 1')
    expect(reg(m, 'rax')).toBe(0x8000000000000000n)
    expect(m.flags).toMatchObject({ OF: true, SF: true, CF: false, ZF: false })
  })
  it('0xFF + 1 in 8 bit sets CF and ZF', () => {
    const m = run('mov al, 0xFF\nadd al, 1')
    expect(reg(m, 'al')).toBe(0n)
    expect(flagStr(m)).toBe('CF=1 PF=1 ZF=1 SF=0 OF=0')
  })
  it('0 - 1 borrows', () => {
    const m = run('mov rax, 0\nsub rax, 1')
    expect(reg(m, 'rax')).toBe(0xffffffffffffffffn)
    expect(flagStr(m)).toBe('CF=1 PF=1 ZF=0 SF=1 OF=0')
  })
  it('MIN - 1 overflows', () => {
    const m = run('mov rax, 0x8000000000000000\nsub rax, 1')
    expect(m.flags).toMatchObject({ OF: true, SF: false, CF: false })
  })
  it('cmp 3, 5 (example from the spec)', () => {
    const m = run('mov rax, 3\nmov rbx, 5\ncmp rax, rbx')
    expect(reg(m, 'rax')).toBe(3n)
    expect(m.flags).toMatchObject({ ZF: false, SF: true, CF: true, OF: false })
  })
  it('cmp equal sets ZF', () => {
    expect(run('mov rax, 5\ncmp rax, 5').flags).toMatchObject({ ZF: true, CF: false, SF: false })
  })
  it('neg 0 clears CF, neg MIN sets OF', () => {
    expect(run('mov rax, 0\nneg rax').flags).toMatchObject({ CF: false, ZF: true, OF: false })
    const m = run('mov al, 0x80\nneg al')
    expect(reg(m, 'al')).toBe(0x80n)
    expect(m.flags).toMatchObject({ CF: true, OF: true, SF: true })
    expect(run('mov rax, 5\nneg rax').flags).toMatchObject({ CF: true, SF: true, OF: false })
  })
  it('PF looks only at the low byte', () => {
    expect(run('mov rax, 0x0103\nadd rax, 0').flags.PF).toBe(true) // 0x03 → two 1-bits
    expect(run('mov rax, 0x0107\nadd rax, 0').flags.PF).toBe(false) // 0x07 → three 1-bits
  })
  it('adc and sbb use the carry (128-bit add)', () => {
    const m = run(`
      mov rax, -1
      mov rdx, 0
      add rax, 1
      adc rdx, 0
      mov rbx, 0
      mov rcx, 1
      sub rbx, 1
      sbb rcx, 0
    `)
    expect(reg(m, 'rax')).toBe(0n)
    expect(reg(m, 'rdx')).toBe(1n)
    expect(reg(m, 'rcx')).toBe(0n)
  })
})

describe('flags: inc / dec / mov / lea / logic', () => {
  it('inc and dec leave CF unchanged', () => {
    const m = load('stc_like: mov al, 0xFF\nadd al, 1\nmov rbx, 5\ninc rbx\ndec rbx\nhlt')
    m.run({ limit: 100 })
    expect(m.flags.CF).toBe(true)
    const t = m.history[3]
    expect(t.flagsAffected).not.toContain('CF')
  })
  it('inc 0x7F...F sets OF, dec 0 sets SF', () => {
    expect(run('mov rax, 0x7FFFFFFFFFFFFFFF\ninc rax').flags).toMatchObject({ OF: true, SF: true })
    expect(run('mov rax, 0\ndec rax').flags).toMatchObject({ SF: true, ZF: false, OF: false })
  })
  it('mov and lea change no flags', () => {
    const m = load('mov rax, 0\ncmp rax, 1\nmov rax, 5\nlea rbx, [rax+1]\nhlt')
    m.step()
    m.step()
    const before = { ...m.flags }
    expect(m.step()!.flagsAffected).toEqual([])
    expect(m.step()!.flagsAffected).toEqual([])
    expect(m.flags).toEqual(before)
  })
  it('and / or / xor / test clear CF and OF', () => {
    const m = run('mov al, 0xFF\nadd al, 1\nmov rax, -1\nand rax, 0x80')
    expect(m.flags).toMatchObject({ CF: false, OF: false, ZF: false, SF: false })
    expect(run('mov rax, 5\ntest rax, rax').flags.ZF).toBe(false)
    expect(run('mov rax, 0\ntest rax, rax').flags.ZF).toBe(true)
    expect(run('mov rax, 0\ntest rax, rax').history.length).toBeGreaterThan(0)
  })
  it('not changes no flags', () => {
    const m = load('mov rax, 0\nnot rax\nhlt')
    m.step()
    expect(m.step()!.flagsAffected).toEqual([])
    expect(reg(m, 'rax')).toBe(0xffffffffffffffffn)
  })
})

describe('shifts and rotates', () => {
  it('shift by 0 changes no flags', () => {
    const m = load('mov al, 0xFF\nadd al, 1\nmov rbx, 5\nshl rbx, 0\nmov cl, 64\nshl rbx, cl\nhlt')
    m.run({ limit: 100 })
    expect(m.flags).toMatchObject({ CF: true, ZF: true })
    expect(m.history[3].flagsAffected).toEqual([])
    // count 64 is masked to 0 for 64-bit operands
    expect(m.history[5].count).toBe(0)
    expect(reg(m, 'rbx')).toBe(5n)
  })
  it('shl sets CF to the last bit out and OF for count 1', () => {
    const m = run('mov al, 0xC0\nshl al, 1')
    expect(reg(m, 'al')).toBe(0x80n)
    expect(m.flags).toMatchObject({ CF: true, OF: false, SF: true })
    const m2 = run('mov al, 0x40\nshl al, 1')
    expect(m2.flags).toMatchObject({ CF: false, OF: true })
  })
  it('shr vs sar on a negative number', () => {
    const m = run('mov rax, -8\nmov rbx, rax\nshr rax, 1\nsar rbx, 1')
    expect(reg(m, 'rax')).toBe(0x7ffffffffffffffcn)
    expect(reg(m, 'rbx')).toBe(0xfffffffffffffffcn)
  })
  it('shr sets OF to the original MSB for count 1; sar clears OF', () => {
    expect(run('mov al, 0x81\nshr al, 1').flags).toMatchObject({ OF: true, CF: true })
    expect(run('mov al, 0x81\nsar al, 1').flags).toMatchObject({ OF: false, CF: true })
  })
  it('OF is undefined (kept) for multi-bit shifts', () => {
    const m = load('mov al, 0x7F\nadd al, 1\nshl rbx, 2\nhlt')
    m.run({ limit: 10 })
    expect(m.history[2].flagsUndefined).toContain('OF')
    expect(m.flags.OF).toBe(true)
  })
  it('shift count from cl', () => {
    expect(reg(run('mov rax, 1\nmov cl, 4\nshl rax, cl'), 'rax')).toBe(16n)
  })
  it('rol / ror', () => {
    const m = run('mov al, 0x81\nrol al, 1\nmov bl, 0x81\nror bl, 1')
    expect(reg(m, 'al')).toBe(0x03n)
    expect(reg(m, 'bl')).toBe(0xc0n)
    expect(reg(run('mov rax, 0x12\nrol rax, 8'), 'rax')).toBe(0x1200n)
    expect(reg(run('mov eax, 1\nror eax, 1'), 'rax')).toBe(0x80000000n)
  })
  it('rotates leave SF/ZF/PF alone', () => {
    const m = load('mov rax, 0\ncmp rax, 0\nmov rbx, 1\nrol rbx, 1\nhlt')
    m.run({ limit: 10 })
    expect(m.flags.ZF).toBe(true)
    expect(m.history[3].flagsAffected.sort()).toEqual(['CF', 'OF'])
  })
})

describe('mul / imul / div / idiv', () => {
  it('mul uses RDX:RAX', () => {
    const m = run('mov rax, 0xFFFFFFFFFFFFFFFF\nmov rbx, 2\nmul rbx')
    expect(reg(m, 'rax')).toBe(0xfffffffffffffffen)
    expect(reg(m, 'rdx')).toBe(1n)
    expect(m.flags).toMatchObject({ CF: true, OF: true })
  })
  it('8-bit mul writes AX', () => {
    const m = run('mov rax, -1\nmov al, 16\nmov bl, 16\nmul bl')
    expect(reg(m, 'rax')).toBe(0xffffffffffff0100n)
    expect(m.flags.CF).toBe(true)
  })
  it('32-bit mul zero-extends EDX and EAX', () => {
    const m = run('mov rax, 3\nmov rdx, -1\nmov ecx, 5\nmul ecx')
    expect(reg(m, 'rax')).toBe(15n)
    expect(reg(m, 'rdx')).toBe(0n)
    expect(m.flags.CF).toBe(false)
  })
  it('imul forms', () => {
    const m = run('mov rax, -3\nmov rbx, 4\nimul rbx\nmov rcx, 7\nimul rcx, rbx\nimul rsi, rbx, -2\nmov rdi, 3\nimul rdi, 5')
    expect(reg(m, 'rax')).toBe(-12n & 0xffffffffffffffffn)
    expect(reg(m, 'rdx')).toBe(0xffffffffffffffffn)
    expect(reg(m, 'rcx')).toBe(28n)
    expect(reg(m, 'rsi')).toBe(-8n & 0xffffffffffffffffn)
    expect(reg(m, 'rdi')).toBe(15n)
  })
  it('imul overflow sets CF/OF', () => {
    expect(run('mov rax, 0x4000000000000000\nimul rax, rax, 2').flags).toMatchObject({ CF: true, OF: true })
    expect(run('mov rax, -1\nmov rbx, 1\nimul rbx').flags).toMatchObject({ CF: false, OF: false })
  })
  it('div: quotient in RAX, remainder in RDX', () => {
    const m = run('mov rdx, 0\nmov rax, 17\nmov rbx, 5\ndiv rbx')
    expect(reg(m, 'rax')).toBe(3n)
    expect(reg(m, 'rdx')).toBe(2n)
  })
  it('8-bit div: AL quotient, AH remainder', () => {
    const m = run('mov ax, 100\nmov bl, 7\ndiv bl')
    expect(reg(m, 'al')).toBe(14n)
    expect(reg(m, 'ah')).toBe(2n)
  })
  it('idiv truncates toward zero, remainder has the dividend sign', () => {
    const m = run('mov rax, -17\nmov rdx, -1\nmov rbx, 5\nidiv rbx')
    expect(reg(m, 'rax')).toBe(-3n & 0xffffffffffffffffn)
    expect(reg(m, 'rdx')).toBe(-2n & 0xffffffffffffffffn)
  })
  it('div by zero raises #DE and leaves the state untouched', () => {
    const m = run('mov rax, 5\nmov rdx, 0\nmov rbx, 0\ndiv rbx')
    expect(m.status).toBe('faulted')
    expect(m.fault?.code).toBe('divideError')
    expect(m.rip).toBe(m.history.at(-1)!.instr.address)
    expect(reg(m, 'rax')).toBe(5n)
  })
  it('idiv MIN / -1 overflows (#DE)', () => {
    const m = run('mov rax, 0x8000000000000000\ncqo_like: mov rdx, -1\nmov rbx, -1\nidiv rbx')
    expect(m.fault?.code).toBe('divideOverflow')
  })
  it('div quotient too large raises #DE', () => {
    expect(run('mov rdx, 1\nmov rax, 0\nmov rbx, 1\ndiv rbx').fault?.code).toBe('divideOverflow')
  })
  it('div/idiv leave flags (undefined) as they were', () => {
    const m = run('mov rax, 0\ncmp rax, 0\nmov rax, 10\nmov rdx, 0\nmov rbx, 3\ndiv rbx')
    expect(m.flags.ZF).toBe(true)
    expect(m.history[5].flagsUndefined.length).toBe(5)
  })
})

describe('memory', () => {
  it('is little-endian', () => {
    const m = run('mov rax, 0x1122334455667788\nmov [buf], rax\nmov bl, [buf]\nmov cx, [buf+6]\nsection .bss\nbuf: resq 1')
    const buf = m.program.sections.bss.start
    expect(Array.from(m.mem.readBytes(buf, 8))).toEqual([0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11])
    expect(reg(m, 'bl')).toBe(0x88n)
    expect(reg(m, 'cx')).toBe(0x1122n)
  })
  it('all addressing-mode combinations', () => {
    const m = run(`
      mov rbx, 0x2000
      mov rcx, 3
      mov qword [0x2000 + rbx + rcx*2], 0x55
      mov rax, [0x4006]
      mov qword [rcx*8], 7
      mov rdx, [24]
      lea rsi, [rbx + rcx*4 + 1]
    `)
    expect(reg(m, 'rax')).toBe(0x55n)
    expect(reg(m, 'rdx')).toBe(7n)
    expect(reg(m, 'rsi')).toBe(0x200dn)
  })
  it('writes into .text fault', () => {
    expect(run('mov byte [0x401000], 0').fault?.code).toBe('writeToCode')
  })
  it('cbw / cwde / cdqe sign-extend the accumulator', () => {
    const m = run('mov rax, -1\nmov al, 0x80\ncbw\nmov rbx, rax\nmov rax, 0x1234567800008000\ncwde\nmov rcx, rax\nmov eax, 0x80000000\ncdqe')
    expect(reg(m, 'rbx')).toBe(0xffffffffffffff80n)
    expect(reg(m, 'rcx')).toBe(0xffff8000n) // 32-bit write zero-extends
    expect(reg(m, 'rax')).toBe(0xffffffff80000000n)
  })
  it('cwd / cdq / cqo fill rdx with the sign bit', () => {
    const m = run('mov rdx, -1\nmov eax, 5\ncdq\nmov rbx, rdx\nmov eax, -7\ncdq\nmov rcx, rdx\nmov rax, -1\ncqo\nmov rsi, rdx\nmov rdx, 0\nmov ax, 0x8000\ncwd')
    expect(reg(m, 'rbx')).toBe(0n)
    expect(reg(m, 'rcx')).toBe(0xffffffffn)
    expect(reg(m, 'rsi')).toBe(0xffffffffffffffffn)
    expect(reg(m, 'rdx')).toBe(0xffffn)
  })
  it('cdq + idiv divides negative 32-bit numbers', () => {
    const m = run('mov eax, -7\ncdq\nmov ecx, 2\nidiv ecx')
    expect(reg(m, 'eax')).toBe(0xfffffffdn)
    expect(reg(m, 'edx')).toBe(0xffffffffn)
  })
  it('movsx / movsxd sign-extend', () => {
    const m = run('mov bl, 0x80\nmovsx rax, bl\nmov ecx, -2\nmovsxd rdx, ecx\nmovsx si, bl')
    expect(reg(m, 'rax')).toBe(0xffffffffffffff80n)
    expect(reg(m, 'rdx')).toBe(0xfffffffffffffffen)
    expect(reg(m, 'si')).toBe(0xff80n)
  })
  it('xchg swaps', () => {
    const m = run('mov rax, 1\nmov rbx, 2\nxchg rax, rbx')
    expect([reg(m, 'rax'), reg(m, 'rbx')]).toEqual([2n, 1n])
  })
})

describe('stack, call and ret', () => {
  it('push / pop move RSP by 8 and store little-endian', () => {
    const m = load('push 0x1234\npop rbx\nhlt')
    const top = BigInt(m.program.stackTop)
    m.step()
    expect(reg(m, 'rsp')).toBe(top - 8n)
    expect(m.mem.read(Number(top - 8n), 8)).toBe(0x1234n)
    m.step()
    expect(reg(m, 'rsp')).toBe(top)
    expect(reg(m, 'rbx')).toBe(0x1234n)
  })
  it('push imm sign-extends', () => {
    const m = load('push -1\nhlt')
    m.step()
    expect(m.mem.read(Number(m.regs[4]), 8)).toBe(0xffffffffffffffffn)
  })
  it('call pushes the return address, ret pops it', () => {
    const m = load('main: call f\nhlt\nf: mov rax, 7\nret')
    const call = m.program.instructions[0]
    m.step()
    expect(m.rip).toBe(m.program.instructions[2].address)
    expect(m.mem.read(Number(m.regs[4]), 8)).toBe(BigInt(call.address + call.length))
    expect(m.stackOrigins.get(Number(m.regs[4]))?.kind).toBe('call')
    m.step()
    m.step()
    expect(m.rip).toBe(call.address + call.length)
    expect(m.regs[4]).toBe(BigInt(m.program.stackTop))
  })
  it('stack frame with arguments at [rbp+0x10]', () => {
    const m = run(`
      main:
        push 42
        call f
        add rsp, 8
        jmp done
      f:
        push rbp
        mov rbp, rsp
        mov rax, [rbp+0x10]
        mov rsp, rbp
        pop rbp
        ret
      done:
    `)
    expect(reg(m, 'rax')).toBe(42n)
    expect(m.regs[4]).toBe(BigInt(m.program.stackTop))
  })
  it('ret imm pops arguments', () => {
    const m = run('push 1\npush 2\ncall f\njmp e\nf: ret 16\ne:')
    expect(m.regs[4]).toBe(BigInt(m.program.stackTop))
  })
  it('indirect call through a register', () => {
    expect(reg(run('lea rax, [f]\ncall rax\njmp e\nf: mov rbx, 9\nret\ne:'), 'rbx')).toBe(9n)
  })
  it('step over executes a whole call', () => {
    const m = load('call f\nmov rbx, 1\nhlt\nf: mov rax, 2\nret')
    m.stepOver({ limit: 100 })
    expect(m.rip).toBe(m.program.instructions[1].address)
    expect(reg(m, 'rax')).toBe(2n)
  })
})

describe('condition codes', () => {
  // Every jcc variant is checked against an independent formula for all 32 flag combinations.
  const reference: Record<string, (f: Record<string, boolean>) => boolean> = {
    o: (f) => f.OF, no: (f) => !f.OF, b: (f) => f.CF, ae: (f) => !f.CF, e: (f) => f.ZF, ne: (f) => !f.ZF,
    be: (f) => f.CF || f.ZF, a: (f) => !f.CF && !f.ZF, s: (f) => f.SF, ns: (f) => !f.SF, p: (f) => f.PF,
    np: (f) => !f.PF, l: (f) => f.SF !== f.OF, ge: (f) => f.SF === f.OF, le: (f) => f.ZF || f.SF !== f.OF,
    g: (f) => !f.ZF && f.SF === f.OF,
  }
  for (const [suffix, cond] of Object.entries(CONDITIONS)) {
    it(`j${suffix}`, () => {
      for (let bitsV = 0; bitsV < 32; bitsV++) {
        const f = { CF: !!(bitsV & 1), PF: !!(bitsV & 2), ZF: !!(bitsV & 4), SF: !!(bitsV & 8), OF: !!(bitsV & 16) }
        expect(evalCondition(cond.key, f)).toBe(reference[cond.key](f))
      }
    })
  }

  it('ja vs jg on the same bits', () => {
    const src = (j: string) => `mov rax, -1\nmov rbx, 1\ncmp rax, rbx\n${j} yes\nmov rcx, 0\njmp e\nyes: mov rcx, 1\ne:`
    expect(reg(run(src('ja')), 'rcx')).toBe(1n) // unsigned: 0xFFFF... > 1
    expect(reg(run(src('jg')), 'rcx')).toBe(0n) // signed: -1 < 1
  })

  it('jcc in a running program follows the flags', () => {
    const m = run('mov rcx, 0\nl: inc rcx\ncmp rcx, 10\njl l')
    expect(reg(m, 'rcx')).toBe(10n)
  })

  it('setcc and cmovcc', () => {
    const m = run('mov rax, 3\ncmp rax, 5\nsetl bl\nsetg cl\nmov rdx, 9\nmov rsi, 1\ncmovl rsi, rdx\nmov rdi, 1\ncmovg rdi, rdx')
    expect(reg(m, 'bl')).toBe(1n)
    expect(reg(m, 'cl')).toBe(0n)
    expect(reg(m, 'rsi')).toBe(9n)
    expect(reg(m, 'rdi')).toBe(1n)
  })

  it('32-bit cmov clears the upper half even if the condition is false', () => {
    const m = run('mov rax, -1\nmov ecx, 5\ncmp ecx, ecx\ncmovne eax, ecx')
    expect(reg(m, 'rax')).toBe(0xffffffffn)
    expect(m.history.at(-2)!.cmovZeroExtend).toBe(true)
  })

  it('loop counts RCX down', () => {
    const m = run('mov rcx, 5\nmov rax, 0\nl: add rax, 2\nloop l')
    expect(reg(m, 'rax')).toBe(10n)
    expect(reg(m, 'rcx')).toBe(0n)
  })
})

describe('syscalls', () => {
  it('write prints to the console and returns the count; exit sets the code', () => {
    const m = load(`
      section .data
      msg: db 'Hi', 10
      section .text
      mov rax, 1
      mov rdi, 1
      mov rsi, msg
      mov rdx, 3
      syscall
      mov rbx, rax
      mov rax, 60
      mov rdi, 3
      syscall
    `)
    m.run({ limit: 100 })
    expect(m.status).toBe('exited')
    expect(m.exitCode).toBe(3)
    expect(m.console).toEqual([{ fd: 1, bytes: [72, 105, 10] }])
    expect(reg(m, 'rbx')).toBe(3n)
  })
  it('syscall clobbers RCX and R11', () => {
    const m = load('section .data\nm: db 1\nsection .text\nmov rcx, 77\nmov rax, 1\nmov rdi, 1\nlea rsi, [m]\nmov rdx, 1\nsyscall\nnext: hlt')
    m.run({ limit: 100 })
    const next = m.program.symbols.find((s) => s.name === 'next')!.value
    expect(reg(m, 'rcx')).toBe(next)
    expect(reg(m, 'r11')).toBe(m.rflags)
  })
  it('unsupported syscalls fault with a clear code', () => {
    const m = run('mov rax, 0\nsyscall')
    expect(m.fault).toEqual({ code: 'unsupportedSyscall', params: { number: '0', name: 'read' } })
  })
})

describe('history and undo', () => {
  it('step back restores every change', () => {
    const src = `
      section .data
      v: dq 5
      section .text
      mov rax, -1
      mov eax, 1
      push rax
      add qword [v], 10
      cmp rax, 2
      call f
      jmp e
      f: ret
      e: mov rax, 60
      mov rdi, 0
      syscall
    `
    const m = load(src)
    const snapshots: string[] = []
    const snap = () => JSON.stringify({
      r: m.regs.map(String), rip: m.rip, f: m.flags, s: m.status,
      mem: Array.from(m.mem.readBytes(m.program.stackTop - 16, 16)), v: String(m.mem.read(m.program.sections.data.start, 8)),
    })
    while (!m.done) {
      snapshots.push(snap())
      m.step()
    }
    expect(m.status).toBe('exited')
    while (m.canStepBack()) {
      m.stepBack()
      expect(snap()).toBe(snapshots.pop())
    }
    expect(m.exitCode).toBeUndefined()
  })
  it('running off the end of .text is reported', () => {
    const m = load('nop')
    m.run({ limit: 10 })
    expect(m.fault?.code).toBe('endOfCode')
  })
  it('run stops at the step limit (infinite loop guard)', () => {
    const m = load('l: jmp l')
    expect(m.run({ limit: 500 })).toEqual({ steps: 500, reason: 'limit' })
  })
  it('run stops at breakpoints', () => {
    const m = load('nop\nnop\nb: nop\nhlt')
    const bp = m.program.instructions[2].address
    expect(m.run({ limit: 100, breakpoints: new Set([bp]) }).reason).toBe('breakpoint')
    expect(m.rip).toBe(bp)
  })
})

describe('symbolize and friendly faults', () => {
  it('return addresses are shown as label+offset', async () => {
    const { symbolize } = await import('../symbols')
    const m = load('main:\n  nop\n  call f\n  hlt\nf:\n.inner: ret')
    const call = m.program.instructions[1]
    expect(symbolize(m.program, call.address + call.length)).toBe('main+0x6')
    expect(symbolize(m.program, m.program.instructions[3].address)).toBe('f')
  })
  it('ret with an empty stack', () => {
    expect(run('ret').fault?.code).toBe('retEmptyStack')
  })
})
