import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { en } from '../../i18n/en'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : files(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

it('every diagnostic code of the toolchain has a message', () => {
  const codes = new Set<string>()
  for (const f of files(join(__dirname, '..'))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(?:err|diag|error)\('([A-Za-z]+)'/g)) codes.add(m[1])
    for (const m of src.matchAll(/code: '([A-Za-z]+)'/g)) codes.add(m[1])
    for (const m of src.matchAll(/: '([A-Za-z]+Unsupported)'/g)) codes.add(m[1])
  }
  expect(codes.size).toBeGreaterThan(80)
  const missing = [...codes].filter((c) => !(c in en.tc.errors))
  expect(missing).toEqual([])
})
