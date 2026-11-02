/** Test helper: run the real `clang -E` on a virtual project (if clang is installed). */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_HEADERS, type Project } from '../project'

export const hasClang = (() => {
  try {
    execFileSync('clang', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

export function clangE(project: Project, main: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cpusim-cc-'))
  const sys = join(dir, 'sys')
  mkdirSync(sys)
  for (const [n, t] of Object.entries(SYSTEM_HEADERS)) writeFileSync(join(sys, n), t)
  for (const f of project.files) writeFileSync(join(dir, f.name), f.text)
  return execFileSync('clang', ['-E', '-P', '-undef', '-nostdinc', '-std=c11', '-isystem', sys, join(dir, main)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
