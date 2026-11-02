/** The C compiler: preprocessed tokens → typed AST → NASM assembly. */
import { DiagnosticError, type Diagnostic } from '../diagnostics'
import type { PPToken } from '../pp/tokens'
import type { TranslationUnit } from './ast'
import { generate, type AsmLine, type CompileStep, type FuncInfo, type StmtInfo, type VarInfo } from './codegen'
import { lex } from './lexer'
import { parse } from './parser'

export type { AsmLine, CompileStep, FuncInfo, StmtInfo, VarInfo, Construct, Note, Section } from './codegen'
export { astTree, type AstNode } from './tree'

export interface CompileResult {
  /** The generated assembly source (`.s`). */
  asm: string
  lines: AsmLine[]
  stmts: StmtInfo[]
  steps: CompileStep[]
  functions: FuncInfo[]
  globals: VarInfo[]
  unit: TranslationUnit | null
  errors: Diagnostic[]
}

/**
 * Compile one translation unit. `sourceLine(file, line)` returns the C source text of a line
 * (used for the comments in the generated assembly).
 */
export function compile(tokens: PPToken[], unitName: string, sourceLine: (file: string, line: number) => string): CompileResult {
  try {
    const unit = parse(lex(tokens), unitName)
    const out = generate(unit, unitName, sourceLine)
    return { asm: out.lines.map((l) => l.text).join('\n') + '\n', ...out, unit, errors: [] }
  } catch (e) {
    if (!(e instanceof DiagnosticError)) throw e
    return { asm: '', lines: [], stmts: [], steps: [], functions: [], globals: [], unit: null, errors: [e.diag] }
  }
}
