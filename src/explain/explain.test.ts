import { describe, expect, it } from 'vitest'
import { load } from '../core/__tests__/helpers'
import { explain } from './explain'

function explainAll(src: string) {
  const m = load(src)
  const out = []
  while (!m.done) {
    const tr = m.step()!
    out.push(explain(tr, m.program))
  }
  return out
}

describe('explanations', () => {
  it('cmp 3, 5 (spec example)', () => {
    const [, , e] = explainAll('mov rax, 3\nmov rbx, 5\ncmp rax, rbx\nhlt')
    expect(e.summary).toBe('`cmp rax, rbx` computes RAX − RBX = 3 − 5 = −2. The result is discarded; only the flags are updated.')
    const f = Object.fromEntries(e.flags.map((x) => [x.flag, x]))
    expect(f.ZF).toMatchObject({ after: false, reason: 'result is not zero' })
    expect(f.SF).toMatchObject({ after: true, reason: 'MSB is 1 → negative' })
    expect(f.CF).toMatchObject({ after: true, reason: 'unsigned: 3 < 5 → borrow' })
    expect(f.OF.after).toBe(false)
  })

  it('jl taken (spec example)', () => {
    const es = explainAll('mov rcx, 0\nloop:\ninc rcx\ncmp rcx, 2\njl loop\nhlt')
    const target = '0x401005 (loop)'
    expect(es[3].summary).toBe(`\`jl loop\`: condition L means SF ≠ OF → 1 ≠ 0 → jump is taken. RIP ← ${target}.`)
    expect(es[6].summary).toContain('0 ≠ 0 → jump is not taken')
  })

  it('mov eax, 1 zero-extends (spec example)', () => {
    const [, e] = explainAll('mov rax, -1\nmov eax, 1\nhlt')
    expect(e.summary).toBe('`mov eax, 1` copies the value 1 into EAX.')
    expect(e.notes).toContain('32-bit write → the upper 32 bits of RAX are set to 0.')
  })

  it('8-bit write keeps the rest', () => {
    const [e] = explainAll('mov al, 2\nhlt')
    expect(e.notes).toContain('8-bit write → the other 56 bits of RAX stay unchanged.')
  })

  it('call and ret name the return address', () => {
    const es = explainAll('main:\ncall f\nhlt\nf: ret')
    expect(es[0].summary).toMatch(/pushes the return address 0x401005 \(main\+0x5\)/)
    expect(es[1].summary).toMatch(/pops the return address 0x401005 \(main\+0x5\)/)
  })

  it('lea computes an address without memory access', () => {
    const [, , e] = explainAll('mov rbx, 0x1000\nmov rcx, 2\nlea rax, [rbx+rcx*4+8]\nhlt')
    expect(e.summary).toBe('`lea rax, [rbx+rcx*4+8]` computes the address RBX + RCX·4 + 0x8 = 0x1010 without accessing memory. RAX ← 0x1010.')
  })

  it('div names quotient and remainder', () => {
    const es = explainAll('mov rax, 17\nmov rdx, 0\nmov rbx, 5\ndiv rbx\nhlt')
    expect(es[3].summary).toContain('17 / 5 = 3 R 2')
    expect(es[3].flags.every((f) => f.undefined)).toBe(true)
  })

  it('write syscall shows the text', () => {
    const es = explainAll("section .data\nm: db 'Hi',10\nsection .text\nmov rax,1\nmov rdi,1\nmov rsi,m\nmov rdx,3\nsyscall\nmov rax,60\nmov rdi,0\nsyscall")
    expect(es[4].summary).toContain('"Hi\\n"')
    expect(es.at(-1)!.summary).toContain('exit code 0')
  })

  it('faults are explained', () => {
    const es = explainAll('mov rbx, 0\ndiv rbx')
    expect(es.at(-1)!.fault).toBe('#DE (divide error): division by zero.')
  })

  it('every instruction kind produces a sentence', () => {
    const es = explainAll(`
      section .data
      v: dq 5
      section .text
      mov rax, 5
      movzx ebx, byte [v]
      movsx rcx, byte [v]
      xchg rax, rbx
      push rax
      pop rdx
      add rax, 1
      adc rax, 1
      sbb rax, 1
      neg rax
      and rax, 0xF
      or rax, 1
      xor rax, 2
      test rax, rax
      not rax
      shl rax, 2
      shr rax, 1
      sar rax, 1
      rol rax, 3
      ror rax, 3
      mul rbx
      imul rax, rbx
      imul rax, rbx, 3
      mov rdx, 0
      mov rcx, 1
      idiv rcx
      sete al
      cmovne rax, rbx
      mov rcx, 2
      l: loop l
      jmp e
      e: nop
      hlt
    `)
    for (const e of es) {
      expect(e.summary.length).toBeGreaterThan(10)
      expect(e.summary).not.toMatch(/undefined|NaN/)
    }
  })
})
