/** Typed syntax tree of the C subset (built by the parser, which also type-checks). */
import type { Loc } from './lexer'
import type { CType } from './types'

export interface VarSym {
  name: string
  type: CType
  kind: 'global' | 'local' | 'param'
  /** Locals and parameters: offset from RBP (negative). */
  offset: number
  /** Globals: the assembly label. */
  label: string
  isStatic: boolean
  isExtern: boolean
  /** Globals: has a definition in this file (with or without initializer). */
  defined: boolean
  init?: Init
  loc: Loc
  used: boolean
}

export interface FuncSym {
  name: string
  type: Extract<CType, { k: 'func' }>
  isStatic: boolean
  defined: boolean
  loc: Loc
  used: boolean
}

type E<K extends string, P> = { k: K; type: CType; loc: Loc } & P

export type Expr =
  | E<'num', { value: bigint; text?: string }>
  | E<'str', { label: string; bytes: number[] }>
  | E<'var', { sym: VarSym }>
  | E<'call', { fn: FuncSym; args: Expr[] }>
  | E<'unary', { op: '-' | '~' | '!'; e: Expr }>
  | E<'binary', { op: BinOp; a: Expr; b: Expr; /** pointer arithmetic: element size */ scale?: number; ptrDiff?: number }>
  | E<'logical', { op: '&&' | '||'; a: Expr; b: Expr }>
  | E<'cond', { c: Expr; a: Expr; b: Expr }>
  | E<'assign', { op: AssignOp; target: Expr; value: Expr; /** compound: operation type */ opType?: CType; scale?: number }>
  | E<'incdec', { op: '++' | '--'; prefix: boolean; e: Expr; step: number }>
  | E<'addr', { e: Expr }>
  | E<'deref', { e: Expr; index?: boolean }>
  | E<'cast', { e: Expr; implicit: boolean }>
  | E<'comma', { a: Expr; b: Expr }>

export type BinOp = '+' | '-' | '*' | '/' | '%' | '<<' | '>>' | '&' | '|' | '^' | '<' | '>' | '<=' | '>=' | '==' | '!='
export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '<<=' | '>>=' | '&=' | '|=' | '^='

export type Init = { k: 'expr'; e: Expr } | { k: 'list'; items: Expr[] } | { k: 'string'; bytes: number[]; loc: Loc }

type S<K extends string, P> = { k: K; loc: Loc; id: number } & P

export type Stmt =
  | S<'expr', { e: Expr }>
  | S<'decl', { vars: VarSym[] }>
  | S<'block', { items: Stmt[] }>
  | S<'if', { c: Expr; then: Stmt; else?: Stmt }>
  | S<'while', { c: Expr; body: Stmt }>
  | S<'do', { body: Stmt; c: Expr }>
  | S<'for', { init?: Stmt; c?: Expr; step?: Expr; body: Stmt }>
  | S<'break', object>
  | S<'continue', object>
  | S<'return', { e?: Expr }>
  | S<'empty', object>

export interface FuncDef {
  sym: FuncSym
  params: VarSym[]
  locals: VarSym[]
  body: Extract<Stmt, { k: 'block' }>
  /** Bytes reserved below RBP (multiple of 16). */
  frameSize: number
  loc: Loc
  endLoc: Loc
}

export type TopLevel = { k: 'func'; def: FuncDef } | { k: 'var'; sym: VarSym; loc: Loc } | { k: 'decl'; name: string; loc: Loc }

export interface TranslationUnit {
  items: TopLevel[]
  globals: Map<string, VarSym>
  funcs: Map<string, FuncSym>
  strings: { label: string; bytes: number[]; loc: Loc }[]
}
