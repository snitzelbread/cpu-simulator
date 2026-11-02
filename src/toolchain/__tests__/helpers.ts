import { Machine } from '../../core/cpu/machine'
import { build, type BuildResult } from '../pipeline'
import type { Project } from '../project'

export function project(files: Record<string, string>): Project {
  return { files: Object.entries(files).map(([name, text]) => ({ name, text })) }
}

export interface RunResult {
  build: BuildResult
  machine: Machine
  exitCode: number | undefined
  output: string
}

/** Build a C project and run it in the emulator until it exits. Throws on build errors. */
export function runC(files: Record<string, string> | string, limit = 200_000): RunResult {
  const b = build(project(typeof files === 'string' ? { 'main.c': files } : files))
  if (b.errors.length) throw new Error('build failed: ' + JSON.stringify(b.errors))
  const m = new Machine(b.ld!.program!)
  m.run({ limit })
  if (m.status !== 'exited') throw new Error(`program did not exit: ${m.status} ${JSON.stringify(m.fault ?? '')}`)
  const output = new TextDecoder().decode(Uint8Array.from(m.console.filter((c) => c.fd === 1).flatMap((c) => c.bytes)))
  return { build: b, machine: m, exitCode: m.exitCode, output }
}

/** Exit code of `int main(void) { return <expr>; }` with optional declarations before it. */
export function evalC(expr: string, decls = ''): number {
  return runC(`${decls}\nint main(void) { return ${expr}; }\n`).exitCode!
}

/** Build errors (first one) for a C source. */
export function buildError(src: string | Record<string, string>) {
  const b = build(project(typeof src === 'string' ? { 'main.c': src } : src))
  return b.errors[0]
}
