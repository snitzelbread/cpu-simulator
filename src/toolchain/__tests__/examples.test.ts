import { describe, expect, it } from 'vitest'
import { Machine } from '../../core/cpu/machine'
import { TOOLCHAIN_EXAMPLES } from '../examples'
import { build } from '../pipeline'

const ex = (id: string) => TOOLCHAIN_EXAMPLES.find((e) => e.id === id)!

function run(id: string) {
  const b = build({ files: ex(id).files })
  expect(b.errors).toEqual([])
  const m = new Machine(b.ld!.program!)
  m.run({ limit: 100_000 })
  expect(m.status).toBe('exited')
  const out = new TextDecoder().decode(Uint8Array.from(m.console.flatMap((c) => c.bytes)))
  return { b, m, exit: m.exitCode, out }
}

describe('toolchain examples', () => {
  it('there are 10, all preprocess without errors', () => {
    expect(TOOLCHAIN_EXAMPLES).toHaveLength(10)
    for (const e of TOOLCHAIN_EXAMPLES) expect(build({ files: e.files }).units.flatMap((u) => u.pp.errors)).toEqual([])
  })
  it('1 comments', () => {
    const r = run('comments')
    expect(r.out).toBe('Hello, world!\n')
    const p1 = r.b.units[0].pp.pass1
    expect(p1.changes.filter((c) => c.kind === 'splice')).toHaveLength(1)
    expect(p1.changes.filter((c) => c.kind !== 'splice').length).toBeGreaterThanOrEqual(4)
  })
  it('2 tokens: the traps are single tokens; 123.X stops in the compiler', () => {
    const b = build({ files: ex('tokens').files })
    const pp = b.units[0].pp
    const texts = pp.pass2.flat().map((t) => t.text)
    expect(texts).toEqual(expect.arrayContaining(['0xE+12', '123.X']))
    expect(pp.pass2.map((l) => l.map((t) => t.text).join(' '))).toContain('c = a ++ ++ + b ;')
    expect(pp.steps.some((s) => s.kind === 'ppnumber' && s.token === '123.X' && s.name === 'X')).toBe(true)
    expect(b.stoppedAt).toBe('cc')
    expect(b.errors[0]).toMatchObject({ code: 'invalidPPNumber', params: { text: '123.X' }, line: 13 })
  })
  it('3 macros', () => {
    const r = run('macros')
    expect(r.out).toBe('123\n6\n5\n9\n')
    const steps = r.b.units[0].pp.steps
    expect(steps.some((s) => s.kind === 'blocked' && s.macro === 'value')).toBe(true)
    expect(steps.filter((s) => s.kind === 'expand' && (s.macro === 'ABC' || s.macro === 'XYZ'))).toHaveLength(2)
  })
  it('4 Übung 4: preprocessor works, the compiler explains floating point is not supported', () => {
    const b = build({ files: ex('uebung4').files })
    expect(b.stoppedAt).toBe('cc')
    expect(b.errors[0]).toMatchObject({ code: 'floatUnsupported', file: 'main.c', line: 7 })
    const tu = b.units[0].pp.lines.map((l) => l.text).join('\n')
    expect(tu).toContain('printf("Wert: %f\\n", 1.2);')
  })
  it('5 globals', () => {
    const r = run('globals')
    expect(r.exit).toBe(15 + 7 + 3)
    const o = r.b.units[0].obj!
    expect(o.symbols.find((s) => s.name === 'hidden')).toMatchObject({ binding: 'local', section: 'data' })
    expect(o.symbols.find((s) => s.name === 'counter')).toMatchObject({ binding: 'global', section: 'bss' })
    expect(r.b.units[0].cc!.asm).toContain('x: dd 15')
  })
  it('6 signed vs unsigned', () => {
    expect(run('signed').out).toBe('1 0\n-3 1431655762\n-4 2147483644\n')
  })
  it('7 for loop', () => expect(run('for').exit).toBe(14))
  it('8 recursion', () => {
    const r = run('recursion')
    expect(r.exit).toBe(10)
  })
  it('9 two translation units', () => {
    const r = run('two-units')
    expect(r.out).toBe('49\n')
    expect(r.exit).toBe(1)
    expect(r.b.objects.map((o) => o.name)).toEqual(['crt0.o', 'main.o', 'util.o', 'libc.o'])
  })
  it('10 broken link', () => {
    const b = build({ files: ex('broken-link').files })
    expect(b.stoppedAt).toBe('ld')
    expect(b.errors).toEqual([expect.objectContaining({ code: 'undefinedReference', params: expect.objectContaining({ name: 'cube', obj: 'main.o', func: 'main' }) })])
  })
})
