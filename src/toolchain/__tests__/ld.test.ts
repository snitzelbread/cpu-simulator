import { describe, expect, it } from 'vitest'
import { assemble } from '../../core/assembler'
import { checkAgainstNasm } from '../../core/__tests__/elf'
import { hasNasm } from '../../core/__tests__/nasm'
import type { Operand } from '../../core/types'
import { build } from '../pipeline'
import { CRT0_SOURCE, LIBC_SOURCE } from '../runtime'
import { buildError, project, runC } from './helpers'

const TWO_UNITS = {
  'main.c': '#include <stdio.h>\n#include "util.h"\nint main(void) {\n  print_int(square(7));\n  return counter;\n}\n',
  'util.h': '#ifndef UTIL_H\n#define UTIL_H\nint square(int x);\nextern int counter;\n#endif\n',
  'util.c': '#include "util.h"\nint counter = 0;\nint square(int x) {\n  counter = counter + 1;\n  return x * x;\n}\n',
}

/** A fixed set of programs used for the consistency checks. */
const PROGRAMS: Record<string, Record<string, string>> = {
  'two units': TWO_UNITS,
  'globals, strings, pointers': {
    'main.c': '#include <stdio.h>\nchar *names[2];\nchar greeting[] = "hello";\nlong big = 1234567890123L;\nint *p;\nint arr[4] = {1,2,3,4};\nint main(void) { p = &arr[2]; names[0] = greeting; puts(names[0]); print_int(big + *p); return 0; }\n',
  },
  'static functions with the same name in two files': {
    'main.c': 'static int helper(void) { return 1; }\nint other(void);\nint main(void) { return helper() * 10 + other(); }\n',
    'other.c': 'static int helper(void) { return 2; }\nint other(void) { return helper(); }\n',
  },
  'loops and recursion': {
    'main.c': 'int fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }\nint main(void) { int s = 0; for (int i = 0; i < 5; i++) s += fact(i); return s; }\n',
  },
}

const opKey = (o: Operand) =>
  o.k === 'reg' ? `r:${o.reg.name}` : o.k === 'imm' ? `i:${o.value}:${o.size ?? ''}` : `m:${o.base?.name ?? ''}:${o.index?.name ?? ''}:${o.scale}:${o.disp}:${o.ripRel}:${o.size ?? ''}`

describe('linking', () => {
  it('two translation units: *UND* symbols are resolved to the other object file', () => {
    const r = runC(TWO_UNITS)
    expect(r.output).toBe('49')
    expect(r.exitCode).toBe(1)
    const b = r.build
    const main = b.objects[1]
    expect(main.name).toBe('main.o')
    expect(main.symbols.filter((s) => s.section === 'UND').map((s) => s.name).sort()).toEqual(['counter', 'print_int', 'square'])
    const res = b.ld!.resolutions.filter((x) => x.obj === 1)
    expect(res.find((x) => x.name === 'square')!.definedIn).toBe(2) // util.o
    expect(res.find((x) => x.name === 'print_int')!.definedIn).toBe(3) // libc.o
    // crt0 calls main
    expect(b.ld!.resolutions.find((x) => x.obj === 0 && x.name === 'main')!.definedIn).toBe(1)
  })
  it('sections are laid out one after another', () => {
    const b = build(project(TWO_UNITS))
    const text = b.ld!.placements.filter((p) => p.section === 'text')
    expect(text[0].start).toBe(0x401000)
    for (let i = 1; i < text.length; i++) expect(text[i].start).toBe(text[i - 1].start + text[i - 1].size)
  })
  it('relocations are patched: no zero placeholders remain for calls', () => {
    const b = build(project(TWO_UNITS))
    for (const p of b.ld!.patches) expect(p.bytes.some((x) => x !== 0) || p.value === 0n).toBe(true)
    const call = b.ld!.program!.instructions.find((i) => i.text === 'call square')!
    expect(call.target).toBe(b.ld!.globals.find((g) => g.name === 'square')!.address)
  })
  it('undefined reference', () => {
    const e = buildError({ 'main.c': 'int helper(int x);\nint main(void) {\n  return helper(2);\n}\n' })
    expect(e).toMatchObject({ stage: 'ld', code: 'undefinedReference', file: 'main.o', params: { name: 'helper', func: 'main' } })
  })
  it('declared but unused functions need no definition', () => {
    expect(runC('int never(void);\nint main(void) { return 4; }').exitCode).toBe(4)
  })
  it('duplicate definition', () => {
    const e = buildError({ 'a.c': 'int f(void) { return 1; }\nint main(void) { return f(); }', 'b.c': 'int f(void) { return 2; }' })
    expect(e).toMatchObject({ stage: 'ld', code: 'duplicateSymbol', params: { name: 'f', first: 'a.o', second: 'b.o' } })
  })
  it('static functions with the same name do not clash', () => {
    const r = runC(PROGRAMS['static functions with the same name in two files'])
    expect(r.exitCode).toBe(12)
    expect(r.build.ld!.listing).toContain('helper@other:')
  })
  it('the CPU view can map listing lines back to C lines', () => {
    const b = build(project(TWO_UNITS))
    const call = b.ld!.program!.instructions.find((i) => i.text === 'call square')!
    expect(b.cLocation(call.line)).toEqual({ file: 'main.c', line: 4 })
  })
  it('missing main', () => {
    expect(buildError({ 'main.c': 'int f(void) { return 1; }' })).toMatchObject({ code: 'undefinedReference', params: { name: 'main' } })
  })
})

describe('the linked image equals the flat listing assembled as one program', () => {
  for (const [name, files] of Object.entries(PROGRAMS)) {
    it(name, () => {
      const b = build(project(files))
      expect(b.errors).toEqual([])
      const linked = b.ld!.program!
      const flat = assemble(b.ld!.listing)
      expect(flat.errors).toEqual([])
      const p = flat.program!
      for (const s of ['text', 'data', 'bss'] as const) {
        expect(p.sections[s].start).toBe(linked.sections[s].start)
        expect(Array.from(p.sections[s].bytes)).toEqual(Array.from(linked.sections[s].bytes))
      }
      expect(p.entry).toBe(linked.entry)
      expect(linked.instructions.length).toBe(p.instructions.length)
      linked.instructions.forEach((ins, i) => {
        const q = p.instructions[i]
        expect([ins.address, ins.line, ins.text, ins.op, ins.mnemonic, ins.opSize, ins.length, ins.target, ins.bytes.join(), ins.operands.map(opKey).join('|')]).toEqual(
          [q.address, q.line, q.text, q.op, q.mnemonic, q.opSize, q.length, q.target, q.bytes.join(), q.operands.map(opKey).join('|')],
        )
      })
      expect(new Map([...linked.sourceMap.lineToAddress].sort())).toEqual(new Map([...p.sourceMap.lineToAddress].sort()))
    })
  }
})

describe.skipIf(!hasNasm)('object files of compiled C match nasm -f elf64', () => {
  it('crt0.o and libc.o', () => {
    checkAgainstNasm(CRT0_SOURCE)
    checkAgainstNasm(LIBC_SOURCE)
  })
  for (const [name, files] of Object.entries(PROGRAMS)) {
    it(name, () => {
      for (const u of build(project(files)).units) checkAgainstNasm(u.cc!.asm)
    })
  }
})
