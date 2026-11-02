import { describe, expect, it } from 'vitest'
import { TOOLCHAIN_EXAMPLES } from '../examples'
import { build } from '../pipeline'
import { buildError, project, runC } from './helpers'
import { checkAgainstNasm } from '../../core/__tests__/elf'
import { hasNasm } from '../../core/__tests__/nasm'

describe('robustness: half-typed code never crashes', () => {
  it('every prefix and every one-line deletion of every example', () => {
    for (const ex of TOOLCHAIN_EXAMPLES) {
      for (const file of ex.files) {
        const lines = file.text.split('\n')
        const variants: string[] = []
        for (let n = 0; n <= lines.length; n++) variants.push(lines.slice(0, n).join('\n'))
        for (let k = 0; k < lines.length; k++) variants.push([...lines.slice(0, k), ...lines.slice(k + 1)].join('\n'))
        // also cut in the middle of lines
        for (let c = 0; c < file.text.length; c += 7) variants.push(file.text.slice(0, c))
        for (const v of variants) {
          const files = ex.files.map((f) => (f === file ? { name: f.name, text: v } : f))
          const b = build({ files })
          expect(b.errors.filter((e) => e.code === 'internalError')).toEqual([])
        }
      }
    }
  })
  it('odd inputs', () => {
    for (const src of ['char *s = "\\x";', "int c = '\\x';", 'int main(void) { return 0x; }', '#define F(', '#if', 'int a[0];', 'int main(void) { return 1 /', '#include', '"', "'", '/*', 'int f(void) { return f; }']) {
      const b = build(project({ 'main.c': src }))
      expect(b.errors.filter((e) => e.code === 'internalError')).toEqual([])
    }
  })
})

describe('numbers: floats vs invalid preprocessor numbers', () => {
  it('0xE+12 and 123.X are pp-numbers but not C constants', () => {
    expect(buildError('int x = 0xE+12;')).toMatchObject({ code: 'invalidPPNumber', params: { text: '0xE+12' } })
    expect(buildError('int x = 123.X;')).toMatchObject({ code: 'invalidPPNumber', params: { text: '123.X' } })
  })
  it('real floating-point constants', () => {
    for (const f of ['1.2', '1e5', '0x1p3', '1.5f', '.5', '3.']) expect(buildError(`int x = ${f};`)).toMatchObject({ code: 'floatUnsupported' })
  })
})

describe('C names that are assembler keywords', () => {
  const src = `unsigned char byte = 3;
int dx = 4;
int test(void) { return 1; }
int add(int a, int b) { return a + b; }
int div(int a, int b) { return a / b; }
int rax(void) { return 2; }
int main(void) { return add(test(), div(dx * 10, 5)) + byte + rax(); }
`
  it('build and run', () => expect(runC(src).exitCode).toBe(1 + 8 + 3 + 2))
  it.skipIf(!hasNasm)('nasm accepts the generated assembly', () => checkAgainstNasm(build(project({ 'main.c': src })).units[0].cc!.asm))
})

describe('compile steps', () => {
  it('line counts per section never decrease and end at the full count', () => {
    for (const ex of TOOLCHAIN_EXAMPLES) {
      const b = build({ files: ex.files })
      for (const u of b.units) {
        if (!u.cc || u.cc.errors.length) continue
        const steps = u.cc.steps
        for (let i = 1; i < steps.length; i++)
          for (const s of ['header', 'text', 'data', 'bss'] as const) expect(steps[i].counts[s]).toBeGreaterThanOrEqual(steps[i - 1].counts[s])
        const last = steps[steps.length - 1].counts
        for (const s of ['header', 'text', 'data', 'bss'] as const) expect(last[s]).toBe(u.cc.lines.filter((l) => l.section === s).length)
      }
    }
  })
})
