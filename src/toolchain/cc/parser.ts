/**
 * Recursive-descent parser for the C subset. It type-checks while parsing (C requires
 * declaration before use), inserts implicit conversions as `cast` nodes and assigns every
 * local variable its place in the stack frame.
 */
import { DiagnosticError } from '../diagnostics'
import type { AssignOp, BinOp, Expr, FuncDef, FuncSym, Init, Stmt, TopLevel, TranslationUnit, VarSym } from './ast'
import type { CToken, Loc } from './lexer'
import { asmName } from './names'
import {
  alignOf, CHAR, decay, INT, isInt, isPtr, isScalar, LONG, promote, ptrTo, sameType, sizeOf, typeName, ULONG, usualArith, VOID,
  type CType,
} from './types'

const MAX_ARGS = 6

interface Specs {
  type: CType
  isStatic: boolean
  isExtern: boolean
  loc: Loc
}

interface Declarator {
  type: CType
  name: string
  loc: Loc
  params?: { name: string; type: CType; loc: Loc }[]
  /** `int a[] = {...}`: length taken from the initializer. */
  openArray?: boolean
}

const UNSUPPORTED_KW: Record<string, string> = {
  struct: 'structUnsupported', union: 'unionUnsupported', enum: 'enumUnsupported', typedef: 'typedefUnsupported',
  float: 'floatUnsupported', double: 'floatUnsupported', switch: 'switchUnsupported', case: 'switchUnsupported',
  default: 'switchUnsupported', goto: 'gotoUnsupported', _Bool: 'boolUnsupported', _Complex: 'floatUnsupported',
}
const TYPE_KW = new Set(['void', 'char', 'short', 'int', 'long', 'unsigned', 'signed'])
const QUALIFIERS = new Set(['const', 'volatile', 'auto', 'register', 'inline', 'restrict'])

export function parse(tokens: CToken[], unitName: string): TranslationUnit {
  return new Parser(tokens, unitName).unit()
}

class Parser {
  pos = 0
  scopes: Map<string, VarSym | FuncSym>[] = [new Map()]
  globals = new Map<string, VarSym>()
  funcs = new Map<string, FuncSym>()
  strings: TranslationUnit['strings'] = []
  stmtId = 0
  loops = 0
  func: { sym: FuncSym; frame: number; locals: VarSym[] } | null = null
  stem: string

  constructor(private toks: CToken[], unitName: string) {
    this.stem = unitName.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_')
  }

  // ------------------------------------------------------------------ helpers

  get t(): CToken {
    return this.toks[this.pos]
  }
  peek(n = 1): CToken {
    return this.toks[Math.min(this.pos + n, this.toks.length - 1)]
  }
  is(text: string): boolean {
    return (this.t.k === 'punct' || this.t.k === 'keyword') && this.t.text === text
  }
  accept(text: string): boolean {
    if (this.is(text)) {
      this.pos++
      return true
    }
    return false
  }
  expect(text: string): CToken {
    if (!this.is(text)) throw this.err(this.t.k === 'eof' ? 'unexpectedEnd' : 'expected', this.t.loc, { expected: text, got: this.t.text })
    return this.toks[this.pos++]
  }
  err(code: string, loc: Loc, params?: Record<string, string | number>) {
    return new DiagnosticError({ stage: 'cc', code, file: loc.file, line: loc.line, col: loc.col, params })
  }
  lookup(name: string): VarSym | FuncSym | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i].get(name)
      if (s) return s
    }
    return undefined
  }
  isTypeStart(): boolean {
    const t = this.t
    return t.k === 'keyword' && (TYPE_KW.has(t.text) || QUALIFIERS.has(t.text) || t.text === 'static' || t.text === 'extern' || t.text in UNSUPPORTED_KW)
  }

  // ------------------------------------------------------------------ declarations

  unit(): TranslationUnit {
    const items: TopLevel[] = []
    while (this.t.k !== 'eof') {
      if (this.t.k === 'keyword' && this.t.text in UNSUPPORTED_KW) throw this.err(UNSUPPORTED_KW[this.t.text], this.t.loc)
      if (!this.isTypeStart()) throw this.err('expectedDeclaration', this.t.loc, { got: this.t.text })
      const specs = this.specs()
      if (this.accept(';')) continue
      let first = true
      for (;;) {
        const d = this.declarator(specs.type, false)
        if (d.type.k === 'func') {
          if (first && this.is('{')) {
            items.push({ k: 'func', def: this.funcDef(specs, d) })
            break
          }
          this.declareFunc(specs, d, false)
          items.push({ k: 'decl', name: d.name, loc: d.loc })
        } else {
          const sym = this.globalVar(specs, d)
          items.push({ k: 'var', sym, loc: d.loc })
        }
        first = false
        if (this.accept(',')) continue
        this.expect(';')
        break
      }
    }
    return { items, globals: this.globals, funcs: this.funcs, strings: this.strings }
  }

  specs(): Specs {
    const loc = this.t.loc
    let isStatic = false
    let isExtern = false
    const words: string[] = []
    while (this.t.k === 'keyword') {
      const w = this.t.text
      if (w in UNSUPPORTED_KW) throw this.err(UNSUPPORTED_KW[w], this.t.loc)
      if (w === 'static') isStatic = true
      else if (w === 'extern') isExtern = true
      else if (TYPE_KW.has(w)) words.push(w)
      else if (!QUALIFIERS.has(w)) break
      this.pos++
    }
    if (isStatic && isExtern) throw this.err('staticExtern', loc)
    return { type: this.baseType(words, loc), isStatic, isExtern, loc }
  }

  baseType(words: string[], loc: Loc): CType {
    if (!words.length) throw this.err('missingType', loc)
    const count = (w: string) => words.filter((x) => x === w).length
    const unsigned = count('unsigned') > 0
    if (count('unsigned') + count('signed') > 1) throw this.err('badType', loc, { type: words.join(' ') })
    if (count('void')) {
      if (words.length > 1) throw this.err('badType', loc, { type: words.join(' ') })
      return VOID
    }
    const longs = count('long')
    if (count('char')) {
      if (words.length - count('unsigned') - count('signed') > 1) throw this.err('badType', loc, { type: words.join(' ') })
      return { k: 'int', size: 1, unsigned }
    }
    if (count('short')) {
      if (longs || count('short') > 1) throw this.err('badType', loc, { type: words.join(' ') })
      return { k: 'int', size: 2, unsigned }
    }
    if (count('int') > 1 || longs > 2) throw this.err('badType', loc, { type: words.join(' ') })
    return { k: 'int', size: longs ? 8 : 4, unsigned }
  }

  /** `*`s, a name (optional if `abstract`) and an array or parameter-list suffix. */
  declarator(base: CType, abstract: boolean): Declarator {
    let type = base
    while (this.accept('*')) {
      type = ptrTo(type)
      while (this.t.k === 'keyword' && QUALIFIERS.has(this.t.text)) this.pos++
    }
    const loc = this.t.loc
    if (this.is('(')) throw this.err('complexDeclarator', loc)
    let name = ''
    if (this.t.k === 'ident') {
      name = this.t.text
      this.pos++
    } else if (!abstract) throw this.err('expectedName', loc, { got: this.t.text })
    const d: Declarator = { type, name, loc }
    if (this.accept('[')) {
      let len = 0
      if (this.is(']')) d.openArray = true
      else {
        const e = this.condExpr()
        const v = constValue(e)
        if (v === null) throw this.err('arraySizeNotConstant', e.loc)
        if (v <= 0n) throw this.err('arraySizeInvalid', e.loc, { size: v.toString() })
        len = Number(v)
      }
      this.expect(']')
      if (this.is('[')) throw this.err('multiDimArray', this.t.loc)
      if (type.k === 'void') throw this.err('voidVariable', loc, { name })
      d.type = { k: 'array', of: type, len }
    } else if (this.is('(')) {
      this.pos++
      const params: Declarator['params'] = []
      let variadic = false
      if (this.is('void') && this.peek().text === ')') this.pos++
      else if (!this.is(')')) {
        for (;;) {
          if (this.accept('...')) {
            variadic = true
            break
          }
          const ps = this.specs()
          const pd = this.declarator(ps.type, true)
          let pt = pd.type
          if (pt.k === 'array') pt = ptrTo(pt.of) // array parameters are pointers
          if (pt.k === 'void') throw this.err('voidVariable', pd.loc, { name: pd.name })
          params.push({ name: pd.name, type: pt, loc: pd.loc })
          if (!this.accept(',')) break
        }
      }
      this.expect(')')
      if (type.k === 'array') throw this.err('badType', loc, { type: 'function returning array' })
      d.type = { k: 'func', ret: type, params: params.map((p) => p.type), variadic }
      d.params = params
    }
    return d
  }

  declareFunc(specs: Specs, d: Declarator, defining: boolean): FuncSym {
    const type = d.type as Extract<CType, { k: 'func' }>
    if (type.params.length > MAX_ARGS) throw this.err('tooManyParams', d.loc, { name: d.name, max: MAX_ARGS })
    const prev = this.scopes[0].get(d.name)
    if (prev && !('defined' in prev && 'type' in prev && prev.type.k === 'func')) throw this.err('redeclaredKind', d.loc, { name: d.name })
    const fp = prev as FuncSym | undefined
    if (fp) {
      if (!sameType(fp.type, type)) throw this.err('conflictingTypes', d.loc, { name: d.name, line: fp.loc.line })
      if (defining && fp.defined) throw this.err('redefinition', d.loc, { name: d.name, line: fp.loc.line })
      if (defining) {
        fp.defined = true
        fp.loc = d.loc
      }
      fp.isStatic ||= specs.isStatic
      return fp
    }
    const sym: FuncSym = { name: d.name, type, isStatic: specs.isStatic, defined: defining, loc: d.loc, used: false }
    this.scopes[0].set(d.name, sym)
    this.funcs.set(d.name, sym)
    return sym
  }

  funcDef(specs: Specs, d: Declarator): FuncDef {
    if (d.type.k === 'func' && d.type.variadic) throw this.err('variadicDefinition', d.loc, { name: d.name })
    for (const p of d.params!) if (!p.name) throw this.err('unnamedParam', p.loc, { name: d.name })
    const sym = this.declareFunc(specs, d, true)
    this.func = { sym, frame: 0, locals: [] }
    this.scopes.push(new Map())
    const params = d.params!.map((p) => this.local(p.name, p.type, p.loc, 'param'))
    const body = this.block(false)
    this.scopes.pop()
    const frameSize = Math.ceil(this.func.frame / 16) * 16
    const def: FuncDef = { sym, params, locals: this.func.locals, body, frameSize, loc: d.loc, endLoc: this.toks[this.pos - 1].loc }
    this.func = null
    return def
  }

  local(name: string, type: CType, loc: Loc, kind: 'local' | 'param'): VarSym {
    const scope = this.scopes[this.scopes.length - 1]
    if (scope.has(name)) throw this.err('redefinition', loc, { name, line: scope.get(name)!.loc.line })
    const f = this.func!
    const size = sizeOf(type)
    f.frame = Math.ceil((f.frame + size) / alignOf(type)) * alignOf(type)
    const sym: VarSym = { name, type, kind, offset: -f.frame, label: '', isStatic: false, isExtern: false, defined: true, loc, used: false }
    scope.set(name, sym)
    f.locals.push(sym)
    return sym
  }

  globalVar(specs: Specs, d: Declarator): VarSym {
    if (d.type.k === 'void') throw this.err('voidVariable', d.loc, { name: d.name })
    let init: Init | undefined
    if (this.accept('=')) {
      if (specs.isExtern) throw this.err('externInit', d.loc, { name: d.name })
      init = this.initializer(d)
    }
    if (d.openArray && !init && !specs.isExtern) throw this.err('arraySizeMissing', d.loc, { name: d.name })
    const prev = this.scopes[0].get(d.name)
    if (prev && !(prev as VarSym).kind) throw this.err('redeclaredKind', d.loc, { name: d.name })
    const pv = prev as VarSym | undefined
    if (pv) {
      const lenOnly = pv.type.k === 'array' && d.type.k === 'array' && sameType(pv.type.of, d.type.of) && (d.openArray || pv.type.len === 0)
      if (!sameType(pv.type, d.type) && !lenOnly) throw this.err('conflictingTypes', d.loc, { name: d.name, line: pv.loc.line })
      if (init && pv.init) throw this.err('redefinition', d.loc, { name: d.name, line: pv.loc.line })
      if (init) {
        pv.init = init
        pv.type = d.type
        pv.loc = d.loc
      }
      if (!specs.isExtern) {
        pv.defined = true
        pv.isExtern = false
      }
      pv.isStatic ||= specs.isStatic
      return pv
    }
    const sym: VarSym = {
      name: d.name, type: d.type, kind: 'global', offset: 0, label: asmName(d.name), isStatic: specs.isStatic,
      isExtern: specs.isExtern, defined: !specs.isExtern, init, loc: d.loc, used: false,
    }
    this.scopes[0].set(d.name, sym)
    this.globals.set(d.name, sym)
    return sym
  }

  /** `= expr`, `= { a, b }` or `= "text"` (char arrays). Fixes the length of `x[]`. */
  initializer(d: Declarator): Init {
    const loc = this.t.loc
    if (d.type.k === 'array') {
      const elem = d.type.of
      if (this.t.k === 'str' && isInt(elem) && elem.size === 1) {
        const bytes = [...(this.t as Extract<CToken, { k: 'str' }>).bytes]
        this.pos++
        if (d.openArray) d.type = { k: 'array', of: elem, len: bytes.length + 1 }
        else if (bytes.length > d.type.len) throw this.err('initTooLong', loc, { name: d.name })
        return { k: 'string', bytes, loc }
      }
      this.expect('{')
      const items: Expr[] = []
      while (!this.is('}')) {
        items.push(this.convert(this.assign(), elem, 'init'))
        if (!this.accept(',')) break
      }
      this.expect('}')
      if (d.openArray) d.type = { k: 'array', of: elem, len: Math.max(1, items.length) }
      else if (items.length > d.type.len) throw this.err('initTooLong', loc, { name: d.name })
      return { k: 'list', items }
    }
    if (this.is('{')) throw this.err('braceScalar', loc)
    return { k: 'expr', e: this.convert(this.assign(), d.type, 'init') }
  }

  // ------------------------------------------------------------------ statements

  sid() {
    return this.stmtId++
  }

  block(newScope = true): Extract<Stmt, { k: 'block' }> {
    const loc = this.expect('{').loc
    if (newScope) this.scopes.push(new Map())
    const items: Stmt[] = []
    while (!this.is('}')) {
      if (this.t.k === 'eof') throw this.err('unexpectedEnd', this.t.loc, { expected: '}', got: '' })
      items.push(this.stmt())
    }
    this.pos++
    if (newScope) this.scopes.pop()
    return { k: 'block', items, loc, id: this.sid() }
  }

  stmt(): Stmt {
    const loc = this.t.loc
    const t = this.t
    if (t.k === 'keyword' && t.text in UNSUPPORTED_KW) throw this.err(UNSUPPORTED_KW[t.text], loc)
    if (this.is('{')) return this.block()
    if (this.isTypeStart()) return this.localDecl()
    if (this.accept(';')) return { k: 'empty', loc, id: this.sid() }
    if (this.accept('if')) {
      const id = this.sid()
      this.expect('(')
      const c = this.condition()
      this.expect(')')
      const then = this.stmt()
      const els = this.accept('else') ? this.stmt() : undefined
      return { k: 'if', c, then, else: els, loc, id }
    }
    if (this.accept('while')) {
      const id = this.sid()
      this.expect('(')
      const c = this.condition()
      this.expect(')')
      const body = this.loopBody()
      return { k: 'while', c, body, loc, id }
    }
    if (this.accept('do')) {
      const id = this.sid()
      const body = this.loopBody()
      this.expect('while')
      this.expect('(')
      const c = this.condition()
      this.expect(')')
      this.expect(';')
      return { k: 'do', body, c, loc, id }
    }
    if (this.accept('for')) {
      const id = this.sid()
      this.expect('(')
      this.scopes.push(new Map())
      let init: Stmt | undefined
      if (this.isTypeStart()) init = this.localDecl()
      else if (!this.accept(';')) {
        const iloc = this.t.loc
        init = { k: 'expr', e: this.expr(), loc: iloc, id: this.sid() }
        this.expect(';')
      }
      const c = this.is(';') ? undefined : this.condition()
      this.expect(';')
      const step = this.is(')') ? undefined : this.expr()
      this.expect(')')
      const body = this.loopBody()
      this.scopes.pop()
      return { k: 'for', init, c, step, body, loc, id }
    }
    if (this.accept('break') || this.accept('continue')) {
      const k = this.toks[this.pos - 1].text as 'break' | 'continue'
      if (!this.loops) throw this.err(k === 'break' ? 'breakOutside' : 'continueOutside', loc)
      this.expect(';')
      return { k, loc, id: this.sid() }
    }
    if (this.accept('return')) {
      const id = this.sid()
      const ret = this.func!.sym.type.ret
      if (this.accept(';')) return { k: 'return', loc, id }
      const e = this.expr()
      if (ret.k === 'void') throw this.err('returnValueInVoid', loc, { name: this.func!.sym.name })
      this.expect(';')
      return { k: 'return', e: this.convert(e, ret, 'return'), loc, id }
    }
    const e = this.expr()
    this.expect(';')
    return { k: 'expr', e, loc, id: this.sid() }
  }

  loopBody(): Stmt {
    this.loops++
    const s = this.stmt()
    this.loops--
    return s
  }

  condition(): Expr {
    const e = this.expr()
    if (!isScalar(decay(e.type))) throw this.err('notScalar', e.loc, { type: typeName(e.type) })
    return e
  }

  localDecl(): Stmt {
    const loc = this.t.loc
    const id = this.sid()
    const specs = this.specs()
    if (specs.isStatic) throw this.err('staticLocal', loc)
    if (specs.isExtern) throw this.err('externLocal', loc)
    const vars: VarSym[] = []
    if (!this.is(';')) {
      for (;;) {
        const d = this.declarator(specs.type, false)
        if (d.type.k === 'func') throw this.err('localFunction', d.loc, { name: d.name })
        if (d.type.k === 'void') throw this.err('voidVariable', d.loc, { name: d.name })
        let init: Init | undefined
        if (this.accept('=')) init = this.initializer(d)
        else if (d.openArray) throw this.err('arraySizeMissing', d.loc, { name: d.name })
        // the variable is in scope from its declarator on (its own initializer may not use it meaningfully)
        const sym = this.local(d.name, d.type, d.loc, 'local')
        sym.init = init
        vars.push(sym)
        if (!this.accept(',')) break
      }
    }
    this.expect(';')
    return { k: 'decl', vars, loc, id }
  }

  // ------------------------------------------------------------------ expressions

  expr(): Expr {
    let e = this.assign()
    while (this.is(',')) {
      const loc = this.t.loc
      this.pos++
      const b = this.assign()
      e = { k: 'comma', a: e, b, type: decay(b.type), loc }
    }
    return e
  }

  assign(): Expr {
    const lhs = this.condExpr()
    const ops: AssignOp[] = ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']
    const op = ops.find((o) => this.is(o))
    if (!op) return lhs
    const loc = this.t.loc
    this.pos++
    this.lvalue(lhs, 'assign')
    const rhs = this.assign()
    const lt = lhs.type
    if (op === '=') return { k: 'assign', op, target: lhs, value: this.convert(rhs, lt, 'assign'), type: lt, loc }
    const bop = op.slice(0, -1) as BinOp
    const rt = decay(rhs.type)
    if ((bop === '+' || bop === '-') && isPtr(lt)) {
      if (!isInt(rt)) throw this.err('badOperands', loc, { op, a: typeName(lt), b: typeName(rt) })
      return { k: 'assign', op, target: lhs, value: this.convert(rhs, LONG, 'arith'), type: lt, loc, opType: lt, scale: sizeOf(lt.to) }
    }
    if (!isInt(lt) || !isInt(rt)) throw this.err('badOperands', loc, { op, a: typeName(lt), b: typeName(rt) })
    if (bop === '<<' || bop === '>>') return { k: 'assign', op, target: lhs, value: this.convert(rhs, promote(rt), 'arith'), type: lt, loc, opType: promote(lt) }
    const T = usualArith(lt, rt)
    return { k: 'assign', op, target: lhs, value: this.convert(rhs, T, 'arith'), type: lt, loc, opType: T }
  }

  condExpr(): Expr {
    const c = this.binary(0)
    if (!this.is('?')) return c
    const loc = this.t.loc
    this.pos++
    if (!isScalar(decay(c.type))) throw this.err('notScalar', c.loc, { type: typeName(c.type) })
    const a = this.expr()
    this.expect(':')
    const b = this.condExpr()
    const at = decay(a.type)
    const bt = decay(b.type)
    let T: CType
    if (isInt(at) && isInt(bt)) T = usualArith(at, bt)
    else if (isPtr(at) && (isPtr(bt) || isNullConst(b))) T = at
    else if (isPtr(bt) && isNullConst(a)) T = bt
    else if (at.k === 'void' && bt.k === 'void') T = VOID
    else throw this.err('badOperands', loc, { op: '?:', a: typeName(at), b: typeName(bt) })
    return { k: 'cond', c, a: this.convert(a, T, 'arith'), b: this.convert(b, T, 'arith'), type: T, loc }
  }

  static LEVELS: string[][] = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']]

  binary(level: number): Expr {
    if (level === Parser.LEVELS.length) return this.unary()
    let a = this.binary(level + 1)
    for (;;) {
      const op = Parser.LEVELS[level].find((o) => this.is(o))
      if (!op) return a
      const loc = this.t.loc
      this.pos++
      const b = this.binary(level + 1)
      a = this.makeBinary(op, a, b, loc)
    }
  }

  makeBinary(op: string, a: Expr, b: Expr, loc: Loc): Expr {
    const at = decay(a.type)
    const bt = decay(b.type)
    const bad = () => this.err('badOperands', loc, { op, a: typeName(at), b: typeName(bt) })
    if (op === '&&' || op === '||') {
      if (!isScalar(at) || !isScalar(bt)) throw bad()
      return { k: 'logical', op, a, b, type: INT, loc }
    }
    if (op === '+' || op === '-') {
      if (isPtr(at) && isInt(bt)) return this.ptrArith(op, a, b, at, loc)
      if (op === '+' && isInt(at) && isPtr(bt)) return this.ptrArith(op, b, a, bt, loc)
      if (op === '-' && isPtr(at) && isPtr(bt)) {
        if (!sameType(at.to, bt.to)) throw bad()
        return { k: 'binary', op, a, b, type: LONG, loc, ptrDiff: sizeOf(at.to) }
      }
    }
    if (['<', '>', '<=', '>=', '==', '!='].includes(op)) {
      if (isInt(at) && isInt(bt)) {
        const T = usualArith(at, bt)
        return { k: 'binary', op: op as BinOp, a: this.convert(a, T, 'arith'), b: this.convert(b, T, 'arith'), type: INT, loc }
      }
      if (isPtr(at) && isPtr(bt)) return { k: 'binary', op: op as BinOp, a, b, type: INT, loc }
      if (isPtr(at) && isNullConst(b)) return { k: 'binary', op: op as BinOp, a, b: this.convert(b, at, 'arith'), type: INT, loc }
      if (isPtr(bt) && isNullConst(a)) return { k: 'binary', op: op as BinOp, a: this.convert(a, bt, 'arith'), b, type: INT, loc }
      throw bad()
    }
    if (!isInt(at) || !isInt(bt)) throw bad()
    if (op === '<<' || op === '>>') {
      const T = promote(at)
      return { k: 'binary', op, a: this.convert(a, T, 'arith'), b: this.convert(b, promote(bt), 'arith'), type: T, loc }
    }
    const T = usualArith(at, bt)
    return { k: 'binary', op: op as BinOp, a: this.convert(a, T, 'arith'), b: this.convert(b, T, 'arith'), type: T, loc }
  }

  ptrArith(op: '+' | '-', p: Expr, i: Expr, pt: Extract<CType, { k: 'ptr' }>, loc: Loc): Expr {
    if (pt.to.k === 'void') throw this.err('voidPointerArith', loc)
    return { k: 'binary', op, a: p, b: this.convert(i, LONG, 'arith'), type: pt, loc, scale: sizeOf(pt.to) }
  }

  unary(): Expr {
    const loc = this.t.loc
    if (this.accept('-') || this.accept('~') || this.accept('+') || this.accept('!')) {
      const op = this.toks[this.pos - 1].text
      const e = this.unary()
      const t = decay(e.type)
      if (op === '!') {
        if (!isScalar(t)) throw this.err('notScalar', loc, { type: typeName(t) })
        return { k: 'unary', op: '!', e, type: INT, loc }
      }
      if (!isInt(t)) throw this.err('badOperand', loc, { op, type: typeName(t) })
      const T = promote(t)
      const ce = this.convert(e, T, 'arith')
      if (op === '+') return ce
      return { k: 'unary', op: op as '-' | '~', e: ce, type: T, loc }
    }
    if (this.accept('&')) {
      const e = this.unary()
      if (e.type.k === 'array') throw this.err('addrOfArray', loc)
      this.lvalue(e, 'addr')
      return { k: 'addr', e, type: ptrTo(e.type), loc }
    }
    if (this.accept('*')) {
      const e = this.unary()
      return this.deref(e, loc, false)
    }
    if (this.accept('++') || this.accept('--')) {
      const op = this.toks[this.pos - 1].text as '++' | '--'
      const e = this.unary()
      return this.incdec(op, true, e, loc)
    }
    if (this.accept('sizeof')) {
      let t: CType
      if (this.is('(') && this.isTypeAt(1)) {
        this.pos++
        t = this.typeName()
        this.expect(')')
      } else t = this.unary().type
      if (t.k === 'func' || t.k === 'void') throw this.err('badSizeof', loc)
      return { k: 'num', value: BigInt(sizeOf(t)), type: ULONG, loc, text: `sizeof = ${sizeOf(t)}` }
    }
    if (this.is('(') && this.isTypeAt(1)) {
      this.pos++
      const t = this.typeName()
      this.expect(')')
      const e = this.unary()
      if (t.k === 'void') return { k: 'cast', e, implicit: false, type: VOID, loc }
      if (!isScalar(t) || !isScalar(decay(e.type))) throw this.err('badCast', loc, { from: typeName(e.type), to: typeName(t) })
      return { k: 'cast', e, implicit: false, type: t, loc }
    }
    return this.postfix()
  }

  isTypeAt(n: number): boolean {
    const t = this.peek(n)
    return t.k === 'keyword' && (TYPE_KW.has(t.text) || QUALIFIERS.has(t.text) || t.text in UNSUPPORTED_KW)
  }

  /** A type in a cast or sizeof: specifiers and `*`s. */
  typeName(): CType {
    const s = this.specs()
    if (s.isStatic || s.isExtern) throw this.err('badCast', s.loc, { from: '', to: 'static' })
    return this.declarator(s.type, true).type
  }

  deref(e: Expr, loc: Loc, index: boolean): Expr {
    const t = decay(e.type)
    if (!isPtr(t)) throw this.err('derefNonPointer', loc, { type: typeName(t) })
    if (t.to.k === 'void') throw this.err('derefVoid', loc)
    return { k: 'deref', e, type: t.to, loc, index }
  }

  incdec(op: '++' | '--', prefix: boolean, e: Expr, loc: Loc): Expr {
    this.lvalue(e, 'incdec')
    if (!isScalar(e.type)) throw this.err('badOperand', loc, { op, type: typeName(e.type) })
    if (isPtr(e.type) && e.type.to.k === 'void') throw this.err('voidPointerArith', loc)
    const step = isPtr(e.type) ? sizeOf(e.type.to) : 1
    return { k: 'incdec', op, prefix, e, type: e.type, loc, step }
  }

  postfix(): Expr {
    let e = this.primary()
    for (;;) {
      const loc = this.t.loc
      if (this.accept('[')) {
        const i = this.expr()
        this.expect(']')
        const at = decay(e.type)
        const it = decay(i.type)
        let sum: Expr
        if (isPtr(at) && isInt(it)) sum = this.ptrArith('+', e, i, at, loc)
        else if (isInt(at) && isPtr(it)) sum = this.ptrArith('+', i, e, it, loc)
        else throw this.err('badSubscript', loc, { type: typeName(at) })
        e = this.deref(sum, loc, true)
      } else if (this.accept('++') || this.accept('--')) {
        e = this.incdec(this.toks[this.pos - 1].text as '++' | '--', false, e, loc)
      } else if (this.is('.') || this.is('->')) {
        throw this.err('structUnsupported', loc)
      } else if (this.is('(')) {
        throw this.err('callNonFunction', loc)
      } else return e
    }
  }

  primary(): Expr {
    const t = this.t
    const loc = t.loc
    if (t.k === 'num') {
      this.pos++
      return { k: 'num', value: t.value, type: t.type, loc, text: t.text }
    }
    if (t.k === 'str') {
      this.pos++
      const label = `str_${this.stem}_${this.strings.length}`
      this.strings.push({ label, bytes: t.bytes, loc })
      return { k: 'str', label, bytes: t.bytes, type: { k: 'array', of: CHAR, len: t.bytes.length + 1 }, loc }
    }
    if (t.k === 'ident') {
      this.pos++
      const sym = this.lookup(t.text)
      if (this.is('(')) {
        if (!sym) throw this.err('implicitDeclaration', loc, { name: t.text })
        if (!('type' in sym) || sym.type.k !== 'func') throw this.err('callNonFunction', loc)
        return this.call(sym as FuncSym, loc)
      }
      if (!sym) throw this.err('undeclared', loc, { name: t.text })
      if (sym.type.k === 'func') throw this.err('functionPointer', loc, { name: t.text })
      const v = sym as VarSym
      v.used = true
      return { k: 'var', sym: v, type: v.type, loc }
    }
    if (this.accept('(')) {
      const e = this.expr()
      this.expect(')')
      return e
    }
    if (t.k === 'keyword' && t.text in UNSUPPORTED_KW) throw this.err(UNSUPPORTED_KW[t.text], loc)
    throw this.err(t.k === 'eof' ? 'unexpectedEnd' : 'expectedExpression', loc, { got: t.text, expected: 'expression' })
  }

  call(fn: FuncSym, loc: Loc): Expr {
    this.expect('(')
    const args: Expr[] = []
    if (!this.is(')')) {
      for (;;) {
        args.push(this.assign())
        if (!this.accept(',')) break
      }
    }
    this.expect(')')
    if (fn.type.variadic) throw this.err('variadicCall', loc, { name: fn.name })
    if (args.length > MAX_ARGS) throw this.err('tooManyArgs', loc, { name: fn.name, max: MAX_ARGS })
    if (args.length !== fn.type.params.length) throw this.err('argCount', loc, { name: fn.name, expected: fn.type.params.length, got: args.length })
    fn.used = true
    const conv = args.map((a, i) => this.convert(a, fn.type.params[i], 'arg'))
    return { k: 'call', fn, args: conv, type: fn.type.ret, loc }
  }

  lvalue(e: Expr, why: string) {
    const ok = (e.k === 'var' && e.type.k !== 'array') || e.k === 'deref'
    if (!ok) throw this.err(e.type.k === 'array' ? 'assignArray' : 'notLvalue', e.loc, { why })
  }

  /** Implicit conversion (assignment, argument, return, arithmetic). */
  convert(e: Expr, to: CType, ctx: 'assign' | 'arg' | 'return' | 'init' | 'arith'): Expr {
    const from = decay(e.type)
    if (from.k === 'void') throw this.err('voidValue', e.loc)
    if (sameType(from, to)) return e
    if (isInt(from) && isInt(to)) return { k: 'cast', e, implicit: true, type: to, loc: e.loc }
    if (isPtr(to) && isPtr(from)) {
      if (to.to.k === 'void' || from.to.k === 'void' || ctx === 'arith') return { k: 'cast', e, implicit: true, type: to, loc: e.loc }
      throw this.err('pointerMismatch', e.loc, { from: typeName(from), to: typeName(to) })
    }
    if (isPtr(to) && isNullConst(e)) return { k: 'cast', e, implicit: true, type: to, loc: e.loc }
    if (isPtr(to) && isInt(from)) throw this.err('intToPointer', e.loc, { from: typeName(from), to: typeName(to) })
    if (isInt(to) && isPtr(from)) throw this.err('pointerToInt', e.loc, { from: typeName(from), to: typeName(to) })
    throw this.err('badConversion', e.loc, { from: typeName(from), to: typeName(to) })
  }
}

function isNullConst(e: Expr): boolean {
  return constValue(e) === 0n && isInt(decay(e.type))
}

/** Value of an integer constant expression, or null. */
export function constValue(e: Expr): bigint | null {
  const wrap = (v: bigint, t: CType) => {
    if (t.k !== 'int') return v
    return t.unsigned ? BigInt.asUintN(t.size * 8, v) : BigInt.asIntN(t.size * 8, v)
  }
  switch (e.k) {
    case 'num':
      return e.value
    case 'cast': {
      const v = constValue(e.e)
      return v === null ? null : wrap(v, e.type)
    }
    case 'unary': {
      const v = constValue(e.e)
      if (v === null) return null
      return wrap(e.op === '-' ? -v : e.op === '~' ? ~v : v === 0n ? 1n : 0n, e.type)
    }
    case 'binary': {
      if (e.scale || e.ptrDiff) return null
      const a = constValue(e.a)
      const b = constValue(e.b)
      if (a === null || b === null) return null
      const t = e.a.type
      const ua = t.k === 'int' && t.unsigned
      const r = ((): bigint | null => {
        switch (e.op) {
          case '+': return a + b
          case '-': return a - b
          case '*': return a * b
          case '/': return b === 0n ? null : a / b
          case '%': return b === 0n ? null : a % b
          case '<<': return a << b
          case '>>': return a >> b
          case '&': return a & b
          case '|': return a | b
          case '^': return a ^ b
          case '<': return BigInt(a < b)
          case '>': return BigInt(a > b)
          case '<=': return BigInt(a <= b)
          case '>=': return BigInt(a >= b)
          case '==': return BigInt(a === b)
          case '!=': return BigInt(a !== b)
        }
      })()
      void ua
      return r === null ? null : wrap(r, e.type)
    }
    case 'logical': {
      const a = constValue(e.a)
      const b = constValue(e.b)
      if (a === null || b === null) return null
      return e.op === '&&' ? BigInt(a !== 0n && b !== 0n) : BigInt(a !== 0n || b !== 0n)
    }
    case 'cond': {
      const c = constValue(e.c)
      if (c === null) return null
      return c ? constValue(e.a) : constValue(e.b)
    }
    default:
      return null
  }
}
