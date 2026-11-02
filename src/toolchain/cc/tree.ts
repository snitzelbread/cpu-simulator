/** A display tree of the AST (for the collapsible AST view). */
import type { Expr, FuncDef, Stmt } from './ast'
import type { Loc } from './lexer'
import { typeName } from './types'

export interface AstNode {
  label: string
  /** C type of an expression. */
  type?: string
  loc: Loc
  stmt?: number
  children: AstNode[]
}

export function astTree(def: FuncDef): AstNode {
  return {
    label: `FunctionDef ${def.sym.name}`,
    type: typeName(def.sym.type),
    loc: def.loc,
    children: [
      ...def.params.map((p) => ({ label: `Param ${p.name}`, type: typeName(p.type), loc: p.loc, children: [] })),
      stmt(def.body),
    ],
  }
}

function stmt(s: Stmt): AstNode {
  const n = (label: string, children: (AstNode | undefined)[]): AstNode => ({ label, loc: s.loc, stmt: s.id, children: children.filter((c): c is AstNode => !!c) })
  switch (s.k) {
    case 'block': return n('Block', s.items.map(stmt))
    case 'expr': return n('ExprStmt', [expr(s.e)])
    case 'decl': return n('Decl', s.vars.map((v) => ({
      label: `Var ${v.name} [rbp${v.offset}]`, type: typeName(v.type), loc: v.loc, children: v.init?.k === 'expr' ? [expr(v.init.e)] : v.init?.k === 'list' ? v.init.items.map(expr) : [],
    })))
    case 'if': return n('If', [expr(s.c), stmt(s.then), s.else && stmt(s.else)])
    case 'while': return n('While', [expr(s.c), stmt(s.body)])
    case 'do': return n('DoWhile', [stmt(s.body), expr(s.c)])
    case 'for': return n('For', [s.init && stmt(s.init), s.c && expr(s.c), s.step && expr(s.step), stmt(s.body)])
    case 'return': return n('Return', [s.e && expr(s.e)])
    case 'break': return n('Break', [])
    case 'continue': return n('Continue', [])
    case 'empty': return n('Empty', [])
  }
}

function expr(e: Expr): AstNode {
  const n = (label: string, children: Expr[]): AstNode => ({ label, type: typeName(e.type), loc: e.loc, children: children.map(expr) })
  switch (e.k) {
    case 'num': return n(`Number ${e.value}`, [])
    case 'str': return n(`String ${e.label}`, [])
    case 'var': return n(`Var ${e.sym.name}`, [])
    case 'call': return n(`Call ${e.fn.name}`, e.args)
    case 'unary': return n(`Unary ${e.op}`, [e.e])
    case 'binary': return n(`Binary ${e.op}${e.scale ? ` (× ${e.scale})` : ''}`, [e.a, e.b])
    case 'logical': return n(`Logical ${e.op}`, [e.a, e.b])
    case 'cond': return n('Conditional ?:', [e.c, e.a, e.b])
    case 'assign': return n(`Assign ${e.op}`, [e.target, e.value])
    case 'incdec': return n(`${e.prefix ? 'Pre' : 'Post'}${e.op === '++' ? 'Inc' : 'Dec'}`, [e.e])
    case 'addr': return n('AddressOf &', [e.e])
    case 'deref': return n(e.index ? 'Index []' : 'Deref *', [e.e])
    case 'cast': return n(e.implicit ? 'ImplicitCast' : 'Cast', [e.e])
    case 'comma': return n('Comma', [e.a, e.b])
  }
}
