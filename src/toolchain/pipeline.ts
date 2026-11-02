/**
 * The whole toolchain: preprocessor → compiler → assembler → linker. Every .c file is a
 * separate translation unit and is compiled on its own; only the linker combines them
 * (together with crt0.o and libc.o). The pipeline stops at the first stage with errors.
 */
import { assembleObject } from '../core/assembler'
import type { ObjectFile } from '../core/object'
import { compile, type CompileResult } from './cc'
import type { Diagnostic, Stage } from './diagnostics'
import { link, type LinkResult } from './linker'
import { preprocess, type PPResult } from './pp'
import { isSourceFile, SYSTEM_HEADERS, type Project } from './project'
import { CRT0_NAME, CRT0_SOURCE, LIBC_NAME, LIBC_SOURCE } from './runtime'

export interface UnitResult {
  /** The .c file. */
  file: string
  /** Its assembly file name (main.s) and object file name (main.o). */
  asmName: string
  objName: string
  pp: PPResult
  cc: CompileResult | null
  obj: ObjectFile | null
}

export interface BuildResult {
  units: UnitResult[]
  /** crt0.o, the units' objects, libc.o — in link order. Empty if a unit failed to assemble. */
  objects: ObjectFile[]
  ld: LinkResult | null
  /** First stage that reported errors (later stages did not run). */
  stoppedAt: Stage | null
  errors: Diagnostic[]
  /** C source location of a line of the linked listing (for the CPU view). */
  cLocation(listingLine: number): { file: string; line: number } | null
}

let runtimeCache: ObjectFile[] | null = null

/** crt0.o and libc.o (assembled once). */
export function runtimeObjects(): ObjectFile[] {
  if (!runtimeCache) {
    runtimeCache = [
      assembleObject(CRT0_SOURCE, CRT0_NAME).object!,
      assembleObject(LIBC_SOURCE, LIBC_NAME).object!,
    ]
  }
  return runtimeCache
}

export function build(project: Project): BuildResult {
  try {
    return buildUnsafe(project)
  } catch (e) {
    // never crash the UI: an unexpected exception is shown as an internal error
    return {
      units: [], objects: [], ld: null, stoppedAt: 'pp', cLocation: () => null,
      errors: [{ stage: 'pp', code: 'internalError', params: { message: e instanceof Error ? e.message : String(e) } }],
    }
  }
}

function buildUnsafe(project: Project): BuildResult {
  const files = project.files.filter((f) => isSourceFile(f.name))
  const sourceLine = (file: string, line: number) => {
    const text = project.files.find((f) => f.name === file)?.text ?? SYSTEM_HEADERS[file.replace(/^<|>$/g, '')] ?? ''
    const l = text.split('\n')[line - 1] ?? ''
    return l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim()
  }
  const units: UnitResult[] = files.map((f) => ({
    file: f.name,
    asmName: f.name.replace(/\.c$/, '.s'),
    objName: f.name.replace(/\.c$/, '.o'),
    pp: preprocess(project, f.name),
    cc: null,
    obj: null,
  }))
  const result = (stoppedAt: Stage | null, errors: Diagnostic[], objects: ObjectFile[] = [], ld: LinkResult | null = null): BuildResult => ({
    units, objects, ld, stoppedAt, errors,
    cLocation(listingLine) {
      if (!ld) return null
      const o = ld.listingOrigin[listingLine - 1]
      if (!o || o.obj === 0 || o.obj > units.length) return null
      const line = units[o.obj - 1].cc?.lines[o.line - 1]
      return line?.loc ? { file: line.loc.file, line: line.loc.line } : null
    },
  })

  if (!files.length) return result('pp', [{ stage: 'pp', code: 'noSourceFiles' }])
  const ppErrors = units.flatMap((u) => u.pp.errors)
  if (ppErrors.length) return result('pp', ppErrors)

  for (const u of units) u.cc = compile(u.pp.tokens, u.file, sourceLine)
  const ccErrors = units.flatMap((u) => u.cc!.errors)
  if (ccErrors.length) return result('cc', ccErrors)

  const asErrors: Diagnostic[] = []
  for (const u of units) {
    const r = assembleObject(u.cc!.asm, u.objName)
    u.obj = r.object
    for (const e of r.errors) asErrors.push({ stage: 'as', code: e.code, params: e.params, file: u.asmName, line: e.line })
  }
  if (asErrors.length) return result('as', asErrors)

  const [crt0, libc] = runtimeObjects()
  const objects = [crt0, ...units.map((u) => u.obj!), libc]
  const ld = link(objects)
  return result(ld.errors.length ? 'ld' : null, ld.errors, objects, ld)
}
