/**
 * Object files (one per translation unit), as produced by `assembleObject`.
 * Modelled on ELF64 relocatable files, but kept as plain data for visualisation.
 */
import type { DataItemInfo, SectionName } from './assembler'
import type { Expr, EvalContext } from './expr'
import type { Instruction, SymTerm } from './types'

export type RelocType = 'R_X86_64_PC32' | 'R_X86_64_32S' | 'R_X86_64_32' | 'R_X86_64_64' | 'R_X86_64_16' | 'R_X86_64_8'

export interface Relocation {
  /** Section containing the bytes to patch. */
  section: SectionName
  /** Offset of the field inside that section. */
  offset: number
  size: 1 | 2 | 4 | 8
  type: RelocType
  target: SymTerm
  /** ELF addend: for section targets relative to the section start, for PC32 already minus the field-to-end distance. */
  addend: bigint
  pcRel: boolean
  line: number
  /** Instruction (index into ObjectFile.instructions) whose operand this patches. */
  instr?: number
  operand?: number
}

export interface ObjSymbol {
  name: string
  /** Offset inside the section (0 for undefined symbols; the value for equ constants). */
  value: bigint
  section: SectionName | 'UND' | 'ABS'
  binding: 'local' | 'global'
  line: number
}

export interface ObjSection {
  name: SectionName
  size: number
  /** Contents with relocation fields set to 0 (as in a real .o file). */
  bytes: Uint8Array
}

export interface ObjectFile {
  name: string
  source: string
  sections: Record<SectionName, ObjSection>
  /** Instructions with section-relative addresses; operands referring to symbols carry a `term`. */
  instructions: Instruction[]
  symbols: ObjSymbol[]
  relocations: Relocation[]
  dataItems: DataItemInfo[]
  /** Source line → offset of its first byte in its section. */
  lineToOffset: Map<number, { section: SectionName; offset: number }>
}

/**
 * Which address an expression is relative to. Labels count per section (so `end - start` of the
 * same section is a plain number again); extern symbols count individually. A valid relocatable
 * expression has exactly one term with coefficient +1.
 */
export function termOf(
  e: Expr,
  ctx: EvalContext,
  sectionOf: (name: string) => SectionName | 'extern' | undefined,
  cur: SectionName,
): SymTerm | null | 'invalid' {
  const labelFor = new Map<string, string>()
  const walk = (x: Expr): Map<string, number> | null => {
    switch (x.k) {
      case 'sym': {
        const s = sectionOf(x.name)
        if (!s) return new Map()
        const key = s === 'extern' ? 'ext:' + x.name : 'sec:' + s
        if (s !== 'extern' && !labelFor.has(key)) labelFor.set(key, x.name)
        return new Map([[key, 1]])
      }
      case 'here':
      case 'start':
        return new Map([['sec:' + cur, 1]])
      case 'un': {
        const m = walk(x.e)
        if (!m) return null
        if (x.op === '-') for (const [k, v] of m) m.set(k, -v)
        else if (x.op === '~' && m.size) return null
        return m
      }
      case 'bin': {
        const a = walk(x.a)
        const b = walk(x.b)
        if (!a || !b) return null
        if (x.op === '+' || x.op === '-') {
          const s = x.op === '+' ? 1 : -1
          for (const [k, v] of b) a.set(k, (a.get(k) ?? 0) + s * v)
          return a
        }
        if (nonzero(a).length || nonzero(b).length) return null
        return new Map()
      }
      default:
        return new Map()
    }
  }
  void ctx
  const m = walk(e)
  if (!m) return 'invalid'
  const terms = nonzero(m)
  if (!terms.length) return null
  if (terms.length > 1 || terms[0][1] !== 1) return 'invalid'
  const key = terms[0][0]
  if (key.startsWith('ext:')) return { kind: 'extern', name: key.slice(4) }
  return { kind: 'section', section: key.slice(4) as SectionName, label: labelFor.get(key) }
}

function nonzero(m: Map<string, number>): [string, number][] {
  return [...m].filter(([, v]) => v !== 0)
}

/** "foo-4", "msg+8", ".data" — how objdump writes a relocation target. */
export function relocTargetText(t: SymTerm, addend: bigint): string {
  const name = t.kind === 'extern' ? t.name : '.' + t.section
  if (addend === 0n) return name
  return addend < 0n ? `${name}-0x${(-addend).toString(16)}` : `${name}+0x${addend.toString(16)}`
}
