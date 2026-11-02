/**
 * Code generator: typed AST → NASM assembly (Intel syntax) for the CPU simulator.
 *
 * Deliberately naive and consistent, so the patterns are easy to recognise:
 *  - every expression leaves its value in RAX (EAX for types of up to 4 bytes),
 *  - a binary operation evaluates the left side, pushes it, evaluates the right side,
 *    moves it to RCX and pops the left side back into RAX,
 *  - every local variable lives in the stack frame at [rbp - n],
 *  - every `if`/loop uses the same label layout.
 * No optimisations. Each C statement gets a comment with its source text and location.
 */
import { DiagnosticError } from '../diagnostics'
import type { Expr, FuncDef, Init, Stmt, TranslationUnit, VarSym } from './ast'
import type { Loc } from './lexer'
import { asmName } from './names'
import { constValue } from './parser'
import { decay, declText, isInt, isPtr, isUnsigned, sizeOf, typeName, type CType } from './types'

export type Construct =
  | 'function' | 'params' | 'epilogue' | 'decl' | 'expr' | 'assign' | 'call' | 'if' | 'else' | 'while' | 'do'
  | 'for' | 'forCond' | 'forStep' | 'break' | 'continue' | 'return' | 'global' | 'globalBss' | 'string' | 'block'

/** Things worth pointing out about the instructions chosen for a statement. */
export type Note =
  | 'imul' | 'mul' | 'idiv' | 'div' | 'sar' | 'shr' | 'cmpSigned' | 'cmpUnsigned' | 'movsx' | 'movzx' | 'movsxd'
  | 'zeroExt32' | 'truncate' | 'ptrScale' | 'ptrDiff' | 'shortCircuit' | 'callAlign' | 'argRegs' | 'retReg'
  | 'strLiteral' | 'uninitLocal' | 'arrayZero' | 'mainReturn0' | 'globalNotAssign' | 'bss'

export type Section = 'header' | 'text' | 'data' | 'bss'

export interface AsmLine {
  text: string
  section: Section
  kind: 'code' | 'label' | 'comment' | 'directive' | 'data' | 'blank'
  /** Statement that produced the line (index into CompileOutput.stmts by id). */
  stmt?: number
  loc?: Loc
}

export interface StmtInfo {
  id: number
  loc: Loc
  construct: Construct
  /** Trimmed C source line. */
  src: string
  notes: Note[]
  func?: string
}

/** One step of the "watch the assembly grow" mode: lines visible per section after it. */
export interface CompileStep {
  stmt: number
  counts: Record<Section, number>
}

export interface VarInfo {
  name: string
  type: string
  size: number
  /** "[rbp-4]" or the label for globals. */
  where: string
  kind: 'param' | 'local' | 'global' | 'static' | 'extern'
  loc: Loc
}

export interface FuncInfo {
  name: string
  loc: Loc
  frameSize: number
  vars: VarInfo[]
}

export interface GenOutput {
  lines: AsmLine[]
  stmts: StmtInfo[]
  steps: CompileStep[]
  functions: FuncInfo[]
  globals: VarInfo[]
}

const ARG64 = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9']
const ARGREG: Record<string, string[]> = {
  rdi: ['dil', 'di', 'edi', 'rdi'], rsi: ['sil', 'si', 'esi', 'rsi'], rdx: ['dl', 'dx', 'edx', 'rdx'],
  rcx: ['cl', 'cx', 'ecx', 'rcx'], r8: ['r8b', 'r8w', 'r8d', 'r8'], r9: ['r9b', 'r9w', 'r9d', 'r9'],
}
const SIZE_IDX: Record<number, number> = { 1: 0, 2: 1, 4: 2, 8: 3 }
const sizedReg = (r64: string, size: number) => ARGREG[r64][SIZE_IDX[size]]
const SIZE_WORD: Record<number, string> = { 1: 'byte', 2: 'word', 4: 'dword', 8: 'qword' }
const DATA_DIR: Record<number, string> = { 1: 'db', 2: 'dw', 4: 'dd', 8: 'dq' }
const RES_DIR: Record<number, string> = { 1: 'resb', 2: 'resw', 4: 'resd', 8: 'resq' }

const ACC = ['al', 'ax', 'eax', 'rax']
const accName = (size: number) => ACC[SIZE_IDX[size]]
const cName = (size: number) => ARGREG.rcx[SIZE_IDX[size]]
/** Register width used for a value of type t: 4 bytes (eax) for everything up to int. */
const width = (t: CType) => (sizeOf(decay(t)) === 8 ? 8 : 4)

export function generate(unit: TranslationUnit, unitName: string, sourceLines: (file: string, line: number) => string): GenOutput {
  return new Gen(unit, unitName, sourceLines).run()
}

class Gen {
  lines: Record<Section, AsmLine[]> = { header: [], text: [], data: [], bss: [] }
  stmts: StmtInfo[] = []
  steps: CompileStep[] = []
  functions: FuncInfo[] = []
  globals: VarInfo[] = []
  cur: StmtInfo | null = null
  lastComment = ''
  synthetic = 1_000_000
  depth = 0
  labelNo = 0
  fn: { def: FuncDef; breaks: string[]; continues: string[]; usesReturn: boolean } | null = null

  constructor(
    private unit: TranslationUnit,
    private unitName: string,
    private source: (file: string, line: number) => string,
  ) {}

  err(code: string, loc: Loc, params?: Record<string, string | number>) {
    return new DiagnosticError({ stage: 'cc', code, file: loc.file, line: loc.line, col: loc.col, params })
  }

  // ------------------------------------------------------------------ output helpers

  push(section: Section, text: string, kind: AsmLine['kind']) {
    this.lines[section].push({ text, section, kind, stmt: this.cur?.id, loc: this.cur?.loc })
  }
  emit(text: string, comment?: string) {
    this.push('text', '    ' + (comment ? text.padEnd(26) + '; ' + comment : text), 'code')
  }
  label(name: string) {
    this.lastComment = ''
    this.push('text', name + ':', 'label')
  }
  note(n: Note) {
    if (this.cur && !this.cur.notes.includes(n)) this.cur.notes.push(n)
  }
  counts(): Record<Section, number> {
    return { header: this.lines.header.length, text: this.lines.text.length, data: this.lines.data.length, bss: this.lines.bss.length }
  }

  /** Start the code of a statement: a comment line with its C source, and a new step. */
  begin(id: number | null, loc: Loc, construct: Construct, section: Section = 'text', srcOverride?: string): StmtInfo {
    if (this.cur) this.steps.push({ stmt: this.cur.id, counts: this.counts() })
    const src = srcOverride ?? this.source(loc.file, loc.line)
    const info: StmtInfo = { id: id ?? this.synthetic++, loc, construct, src, notes: [], func: this.fn?.def.sym.name }
    this.stmts.push(info)
    const prev = this.lastComment
    this.cur = info
    const where = `(${loc.file}:${loc.line})`
    this.lastComment = `${section}|${src}|${where}`
    // a statement on the same source line as the previous one (e.g. `if (c) x = 1;`) needs no second comment
    if (prev === this.lastComment) return info
    this.push(section, `${section === 'text' && construct !== 'function' ? '    ' : ''}; ${src}  ${where}`, 'comment')
    return info
  }

  newLabel(kind: string): string {
    return `.${kind}_${++this.labelNo}`
  }

  // ------------------------------------------------------------------ top level

  run(): GenOutput {
    const u = this.unit
    const header = this.lines.header
    const hl = (text: string, kind: AsmLine['kind'] = 'directive') => header.push({ text, section: 'header', kind })
    hl(`; ${this.unitName} → ${this.unitName.replace(/\.c$/, '.s')}   compiled by the simulator's teaching compiler (no optimisation)`, 'comment')
    hl('default rel')

    const emitted = new Set<VarSym>()
    for (const item of u.items) {
      if (item.k === 'func') this.func(item.def)
      else if (item.k === 'var' && !emitted.has(item.sym)) {
        // emitted once, where it is first declared (later declarations only complete it)
        emitted.add(item.sym)
        this.global(item.sym)
      }
    }
    // string literals go into .data
    for (const s of u.strings) {
      this.begin(null, s.loc, 'string', 'data', `string literal "${printable(s.bytes)}"`)
      this.note('strLiteral')
      this.push('data', `${s.label}: ${dbList([...s.bytes, 0])}`, 'data')
    }
    if (this.cur) this.steps.push({ stmt: this.cur.id, counts: this.counts() })

    // global / extern lines in the header
    const globals = [...u.funcs.values()].filter((f) => f.defined && !f.isStatic).map((f) => asmName(f.name))
    globals.push(...[...u.globals.values()].filter((g) => g.defined && !g.isStatic).map((g) => g.label))
    const externs = [...u.funcs.values()].filter((f) => !f.defined && f.used).map((f) => asmName(f.name))
    externs.push(...[...u.globals.values()].filter((g) => !g.defined && g.used).map((g) => g.label))
    if (globals.length) hl('global ' + globals.join(', '))
    if (externs.length) hl('extern ' + externs.join(', '))
    for (const s of ['text', 'data', 'bss'] as const) {
      if (s !== 'text' && !this.lines[s].length) continue
      this.lines[s].unshift({ text: '', section: s, kind: 'blank' }, { text: `section .${s}`, section: s, kind: 'directive' })
      for (const st of this.steps) st.counts[s] += 2
    }
    for (const st of this.steps) st.counts.header = this.lines.header.length

    const lines = [...this.lines.header, ...this.lines.text, ...this.lines.data, ...this.lines.bss]
    return { lines, stmts: this.stmts, steps: this.steps, functions: this.functions, globals: this.globals }
  }

  global(g: VarSym) {
    const kind: VarInfo['kind'] = g.defined ? (g.isStatic ? 'static' : 'global') : 'extern'
    this.globals.push({ name: g.name, type: typeName(g.type), size: sizeOf(g.type), where: g.label, kind, loc: g.loc })
    if (!g.defined) return
    const size = sizeOf(g.type)
    const elem = g.type.k === 'array' ? g.type.of : g.type
    const unit = sizeOf(elem)
    if (!g.init) {
      this.begin(null, g.loc, 'globalBss', 'bss')
      this.note('bss')
      const n = g.type.k === 'array' ? g.type.len : 1
      this.push('bss', `${g.label}: ${RES_DIR[unit]} ${n}`.padEnd(30) + `; ${declText(g.type, g.name)}: ${size} bytes, zero at program start`, 'data')
      return
    }
    this.begin(null, g.loc, 'global', 'data')
    this.note('globalNotAssign')
    const comment = `; ${declText(g.type, g.name)}: ${size} bytes`
    const init = g.init
    if (init.k === 'string') {
      const n = (g.type as Extract<CType, { k: 'array' }>).len
      const bytes = [...init.bytes, ...new Array(Math.max(0, n - init.bytes.length)).fill(0)].slice(0, n)
      this.push('data', `${g.label}: ${dbList(bytes)}`.padEnd(30) + comment, 'data')
      return
    }
    const items = init.k === 'list' ? init.items : [init.e]
    const values = items.map((e) => this.staticValue(e, unit))
    const n = g.type.k === 'array' ? g.type.len : 1
    let text = `${g.label}: ${DATA_DIR[unit]} ${values.join(', ')}`
    const rest = n - values.length
    if (rest > 0 && rest <= 8) text += ', ' + new Array(rest).fill('0').join(', ')
    this.push('data', text.padEnd(30) + comment, 'data')
    if (rest > 8) this.push('data', `    times ${rest} ${DATA_DIR[unit]} 0`.padEnd(30) + '; the remaining elements are 0', 'data')
  }

  /** A constant (or address constant) for a global initializer, as assembler text. */
  staticValue(e: Expr, unit: number): string {
    const v = constValue(e)
    if (v !== null) return v.toString()
    const addr = this.addressConst(e)
    if (!addr) throw this.err('initNotConstant', e.loc)
    if (unit !== 8) throw this.err('initNotConstant', e.loc)
    return addr.offset ? `${addr.label} + ${addr.offset}` : addr.label
  }

  addressConst(e: Expr): { label: string; offset: number } | null {
    switch (e.k) {
      case 'str': return { label: e.label, offset: 0 }
      case 'var': return e.sym.kind === 'global' && e.type.k === 'array' ? { label: e.sym.label, offset: 0 } : null
      case 'addr': {
        if (e.e.k === 'var' && e.e.sym.kind === 'global') return { label: e.e.sym.label, offset: 0 }
        if (e.e.k === 'deref') return this.addressConst(e.e.e)
        return null
      }
      case 'cast': return isPtr(decay(e.e.type)) || e.e.type.k === 'array' ? this.addressConst(e.e) : null
      case 'binary': {
        if (!e.scale) return null
        const base = this.addressConst(e.a)
        const idx = constValue(e.b)
        if (!base || idx === null) return null
        return { label: base.label, offset: base.offset + (e.op === '-' ? -1 : 1) * Number(idx) * e.scale }
      }
      default: return null
    }
  }

  func(def: FuncDef) {
    this.fn = { def, breaks: [], continues: [], usesReturn: false }
    this.labelNo = 0
    this.depth = 0
    const sym = def.sym
    const vars: VarInfo[] = def.locals.map((v) => ({
      name: v.name, type: typeName(v.type), size: sizeOf(v.type), where: `[rbp${v.offset}]`, kind: v.kind === 'param' ? 'param' : 'local', loc: v.loc,
    }))
    this.functions.push({ name: sym.name, loc: def.loc, frameSize: def.frameSize, vars })

    this.push('text', '', 'blank')
    this.begin(null, def.loc, 'function')
    this.label(asmName(sym.name))
    this.emit('push rbp', 'save the caller\'s frame pointer')
    this.emit('mov rbp, rsp', 'new frame: locals live below rbp')
    if (def.frameSize) this.emit(`sub rsp, ${def.frameSize}`, `${def.frameSize} bytes for local variables`)
    if (def.params.length) {
      this.begin(null, def.loc, 'params', 'text', `parameters → stack frame`)
      this.note('argRegs')
      def.params.forEach((p, i) => {
        const size = sizeOf(p.type)
        this.emit(`mov ${SIZE_WORD[size]} [rbp${p.offset}], ${sizedReg(ARG64[i], size)}`, `${declText(p.type, p.name)}`)
      })
    }
    const body = def.body.items
    body.forEach((s, i) => this.stmt(s, i === body.length - 1))
    const last = body[body.length - 1]
    const endsWithReturn = last?.k === 'return'
    this.begin(null, def.endLoc, 'epilogue', 'text', `end of ${sym.name}`)
    if (sym.name === 'main' && !endsWithReturn) {
      this.note('mainReturn0')
      this.emit('mov eax, 0', 'main returns 0 when it reaches its end')
    }
    if (this.fn.usesReturn) this.label('.return')
    this.emit('mov rsp, rbp', 'free the locals')
    this.emit('pop rbp', 'restore the caller\'s frame pointer')
    this.emit('ret')
    this.fn = null
  }

  // ------------------------------------------------------------------ statements

  stmt(s: Stmt, lastInFunction = false) {
    const f = this.fn!
    switch (s.k) {
      case 'block':
        for (const x of s.items) this.stmt(x)
        return
      case 'empty':
        return
      case 'expr': {
        const e = s.e
        this.begin(s.id, s.loc, e.k === 'assign' ? 'assign' : e.k === 'call' ? 'call' : 'expr')
        this.gen(e)
        return
      }
      case 'decl': {
        this.begin(s.id, s.loc, 'decl')
        for (const v of s.vars) this.localInit(v)
        return
      }
      case 'if': {
        this.begin(s.id, s.loc, 'if')
        const n = ++this.labelNo
        const elseL = `.else_${n}`
        const endL = `.endif_${n}`
        this.branch(s.c, s.else ? elseL : endL, false)
        this.stmt(s.then)
        if (s.else) {
          this.begin(null, s.else.loc, 'else', 'text', 'else')
          this.emit(`jmp ${endL}`, 'then-part done: skip the else-part')
          this.label(elseL)
          this.stmt(s.else)
        }
        this.label(endL)
        return
      }
      case 'while': {
        this.begin(s.id, s.loc, 'while')
        const n = ++this.labelNo
        const [cond, body, end] = [`.while_cond_${n}`, `.while_body_${n}`, `.while_end_${n}`]
        this.emit(`jmp ${cond}`, 'check the condition first')
        this.label(body)
        f.breaks.push(end)
        f.continues.push(cond)
        this.stmt(s.body)
        f.breaks.pop()
        f.continues.pop()
        this.begin(null, s.loc, 'forCond', 'text', `while condition: ${exprText(this.source(s.loc.file, s.loc.line), 'while')}`)
        this.label(cond)
        this.branch(s.c, body, true)
        this.label(end)
        return
      }
      case 'do': {
        this.begin(s.id, s.loc, 'do')
        const n = ++this.labelNo
        const [body, cond, end] = [`.do_body_${n}`, `.do_cond_${n}`, `.do_end_${n}`]
        this.label(body)
        f.breaks.push(end)
        f.continues.push(cond)
        this.stmt(s.body)
        f.breaks.pop()
        f.continues.pop()
        this.begin(null, s.c.loc, 'forCond', 'text', `do-while condition`)
        this.label(cond)
        this.branch(s.c, body, true)
        this.label(end)
        return
      }
      case 'for': {
        this.begin(s.id, s.loc, 'for')
        const n = ++this.labelNo
        const [body, next, cond, end] = [`.for_body_${n}`, `.for_next_${n}`, `.for_cond_${n}`, `.for_end_${n}`]
        if (s.init) {
          if (s.init.k === 'decl') for (const v of s.init.vars) this.localInit(v)
          else if (s.init.k === 'expr') this.gen(s.init.e)
        }
        this.emit(`jmp ${cond}`, 'check the condition first')
        this.label(body)
        f.breaks.push(end)
        f.continues.push(next)
        this.stmt(s.body)
        f.breaks.pop()
        f.continues.pop()
        this.begin(null, s.loc, 'forStep', 'text', 'for: increment')
        this.label(next)
        if (s.step) this.gen(s.step)
        this.begin(null, s.loc, 'forCond', 'text', 'for: condition')
        this.label(cond)
        if (s.c) this.branch(s.c, body, true)
        else this.emit(`jmp ${body}`, 'no condition: loop forever')
        this.label(end)
        return
      }
      case 'break':
      case 'continue': {
        this.begin(s.id, s.loc, s.k)
        const t = s.k === 'break' ? f.breaks.at(-1)! : f.continues.at(-1)!
        this.emit(`jmp ${t}`)
        return
      }
      case 'return': {
        this.begin(s.id, s.loc, 'return')
        if (s.e) {
          this.gen(s.e)
          this.note('retReg')
        }
        if (!lastInFunction) {
          f.usesReturn = true
          this.emit('jmp .return', 'leave the function')
        }
        return
      }
    }
  }

  localInit(v: VarSym) {
    const size = sizeOf(v.type)
    const at = (off: number) => `[rbp-${-off}]`
    if (!v.init) {
      this.note('uninitLocal')
      return
    }
    const init: Init = v.init
    if (init.k === 'expr') {
      this.gen(init.e)
      this.emit(`mov ${at(v.offset)}, ${accName(size)}`, `${v.name} = ...`)
      return
    }
    const arr = v.type as Extract<CType, { k: 'array' }>
    const unit = sizeOf(arr.of)
    const values: (Expr | number)[] = init.k === 'list' ? init.items : [...init.bytes]
    for (let i = 0; i < arr.len; i++) {
      const off = v.offset + i * unit
      const x = values[i]
      if (x === undefined) {
        this.note('arrayZero')
        this.emit(`mov ${SIZE_WORD[unit]} ${at(off)}, 0`, `${v.name}[${i}] = 0`)
      } else if (typeof x === 'number') this.emit(`mov byte ${at(off)}, ${x}`, `${v.name}[${i}] = ${charText(x)}`)
      else {
        const c = constValue(x)
        if (c !== null && fitsImm32(c)) this.emit(`mov ${SIZE_WORD[unit]} ${at(off)}, ${c}`, `${v.name}[${i}]`)
        else {
          this.gen(x)
          this.emit(`mov ${at(off)}, ${accName(unit)}`, `${v.name}[${i}]`)
        }
      }
    }
  }

  // ------------------------------------------------------------------ expressions

  /** Memory operand of a variable: [rbp-n] or [rel label]. */
  ref(v: VarSym): string {
    v.used = true
    return v.kind === 'global' ? `[rel ${v.label}]` : `[rbp${v.offset}]`
  }

  /** Is the expression a variable we can address directly? */
  direct(e: Expr): string | null {
    return e.k === 'var' && e.type.k !== 'array' ? this.ref(e.sym) : null
  }

  load(t: CType, mem: string, comment?: string) {
    const size = sizeOf(t)
    if (size === 1 || size === 2) {
      const signed = !isUnsigned(t)
      this.note(signed ? 'movsx' : 'movzx')
      this.emit(`${signed ? 'movsx' : 'movzx'} eax, ${SIZE_WORD[size]} ${mem}`, comment)
    } else this.emit(`mov ${accName(size)}, ${mem}`, comment)
  }

  store(t: CType, mem: string, comment?: string) {
    this.emit(`mov ${mem}, ${accName(sizeOf(t))}`, comment)
  }

  pushRax() {
    this.emit('push rax', 'save the left operand')
    this.depth++
  }
  pop(reg: string, comment?: string) {
    this.emit(`pop ${reg}`, comment)
    this.depth--
  }

  gen(e: Expr): void {
    switch (e.k) {
      case 'num': {
        const w = width(e.type)
        this.emit(`mov ${accName(w)}, ${e.value}`, e.text?.startsWith('sizeof') ? e.text : undefined)
        return
      }
      case 'str':
        this.note('strLiteral')
        this.emit(`lea rax, [rel ${e.label}]`, 'address of the string')
        return
      case 'var':
        if (e.type.k === 'array') {
          this.emit(`lea rax, ${this.ref(e.sym)}`, `address of ${e.sym.name}[0]`)
          return
        }
        this.load(e.type, this.ref(e.sym), e.sym.name)
        return
      case 'addr':
        this.genAddr(e.e)
        return
      case 'deref':
        if (e.type.k === 'array') {
          this.genAddr(e)
          return
        }
        this.genAddr(e)
        this.load(e.type, '[rax]')
        return
      case 'cast':
        this.gen(e.e)
        this.convert(decay(e.e.type), e.type)
        return
      case 'unary': {
        this.gen(e.e)
        const w = width(e.type)
        if (e.op === '-') this.emit(`neg ${accName(w)}`)
        else if (e.op === '~') this.emit(`not ${accName(w)}`)
        else {
          const ew = width(e.e.type)
          this.emit(`cmp ${accName(ew)}, 0`)
          this.emit('sete al', '!x is 1 if x == 0')
          this.emit('movzx eax, al')
        }
        return
      }
      case 'binary':
        return this.binary(e)
      case 'logical':
      case 'cond': {
        if (e.k === 'logical') {
          const f = this.newLabel(e.op === '&&' ? 'and_false' : 'or_false')
          const end = this.newLabel(e.op === '&&' ? 'and_end' : 'or_end')
          this.branch(e, f, false)
          this.emit('mov eax, 1')
          this.emit(`jmp ${end}`)
          this.label(f)
          this.emit('mov eax, 0')
          this.label(end)
          return
        }
        const els = this.newLabel('cond_else')
        const end = this.newLabel('cond_end')
        this.branch(e.c, els, false)
        this.gen(e.a)
        this.emit(`jmp ${end}`)
        this.label(els)
        this.gen(e.b)
        this.label(end)
        return
      }
      case 'assign':
        return this.assign(e)
      case 'incdec': {
        const size = sizeOf(e.type)
        const op = e.op === '++' ? 'add' : 'sub'
        let mem = this.direct(e.e)
        if (!mem) {
          this.genAddr(e.e)
          this.emit('mov rdi, rax', 'address of the variable')
          mem = '[rdi]'
        }
        if (e.step > 1) this.note('ptrScale')
        if (e.prefix) {
          this.emit(`${op} ${SIZE_WORD[size]} ${mem}, ${e.step}`, `${e.op}: change it first`)
          this.load(e.type, mem, 'then use the new value')
        } else {
          this.load(e.type, mem, 'use the old value')
          this.emit(`${op} ${SIZE_WORD[size]} ${mem}, ${e.step}`, `then ${e.op}`)
        }
        return
      }
      case 'call':
        return this.call(e)
      case 'comma':
        this.gen(e.a)
        this.gen(e.b)
        return
    }
  }

  genAddr(e: Expr) {
    if (e.k === 'var') {
      this.emit(`lea rax, ${this.ref(e.sym)}`, `address of ${e.sym.name}`)
      return
    }
    if (e.k === 'deref') {
      this.gen(e.e)
      return
    }
    throw this.err('notLvalue', e.loc, { why: 'addr' })
  }

  /** Evaluate a and b: a in RAX, b in RCX — or b as an immediate if it is a small constant. */
  operands(a: Expr, b: Expr, allowImm = true): string {
    const w = width(a.type)
    const c = constValue(b)
    if (c !== null && fitsImm32(c)) {
      this.gen(a)
      if (allowImm) return c.toString()
      this.emit(`mov ${cName(w)}, ${c}`, 'right operand → rcx')
      return cName(w)
    }
    this.gen(a)
    this.pushRax()
    this.gen(b)
    this.emit(`mov ${cName(width(b.type) === 8 ? 8 : w)}, ${accName(width(b.type) === 8 ? 8 : w)}`, 'right operand → rcx')
    this.pop('rax', 'left operand back into rax')
    return cName(w)
  }

  binary(e: Extract<Expr, { k: 'binary' }>) {
    if (e.scale) {
      // pointer ± integer: the integer counts elements, so it is multiplied by the element size
      this.gen(e.a)
      this.pushRax()
      this.gen(e.b)
      if (e.scale > 1) {
        this.note('ptrScale')
        this.emit(`imul rax, rax, ${e.scale}`, `× ${e.scale} bytes per element`)
      }
      this.emit('mov rcx, rax')
      this.pop('rax')
      this.emit(`${e.op === '+' ? 'add' : 'sub'} rax, rcx`)
      return
    }
    if (e.ptrDiff) {
      this.note('ptrDiff')
      const b = this.operands(e.a, e.b, false)
      this.emit(`sub rax, ${b}`, 'difference in bytes')
      if (e.ptrDiff > 1) {
        const log = Math.log2(e.ptrDiff)
        if (Number.isInteger(log)) this.emit(`sar rax, ${log}`, `÷ ${e.ptrDiff}: number of elements`)
        else {
          this.emit(`mov ecx, ${e.ptrDiff}`)
          this.emit('cqo')
          this.emit('idiv rcx', `÷ ${e.ptrDiff}: number of elements`)
        }
      }
      return
    }
    const t = e.a.type
    const w = width(t)
    const unsigned = isUnsigned(t)
    const acc = accName(w)
    const cmpOps: Record<string, [string, string]> = { '<': ['l', 'b'], '>': ['g', 'a'], '<=': ['le', 'be'], '>=': ['ge', 'ae'], '==': ['e', 'e'], '!=': ['ne', 'ne'] }
    if (e.op in cmpOps) {
      const b = this.operands(e.a, e.b)
      const cc = cmpOps[e.op][unsigned ? 1 : 0]
      if (e.op !== '==' && e.op !== '!=') this.note(unsigned ? 'cmpUnsigned' : 'cmpSigned')
      this.emit(`cmp ${acc}, ${b}`)
      this.emit(`set${cc} al`, `al = (${e.op}) ? 1 : 0${e.op !== '==' && e.op !== '!=' ? (unsigned ? ', unsigned' : ', signed') : ''}`)
      this.emit('movzx eax, al')
      return
    }
    switch (e.op) {
      case '+': case '-': case '&': case '|': case '^': {
        const b = this.operands(e.a, e.b)
        const m = { '+': 'add', '-': 'sub', '&': 'and', '|': 'or', '^': 'xor' }[e.op]
        this.emit(`${m} ${acc}, ${b}`)
        return
      }
      case '*': {
        if (unsigned) {
          this.note('mul')
          const b = this.operands(e.a, e.b, false)
          this.emit(`mul ${b}`, 'unsigned: rdx:rax = rax × rcx')
        } else {
          this.note('imul')
          const b = this.operands(e.a, e.b)
          this.emit(/^-?\d/.test(b) ? `imul ${acc}, ${acc}, ${b}` : `imul ${acc}, ${b}`, 'signed multiplication')
        }
        return
      }
      case '/': case '%': {
        const b = this.operands(e.a, e.b, false)
        this.divide(w, unsigned, b)
        if (e.op === '%') this.emit(`mov ${acc}, ${w === 8 ? 'rdx' : 'edx'}`, 'the remainder is in edx')
        return
      }
      case '<<': case '>>': {
        const c = constValue(e.b)
        let count: string
        if (c !== null && c >= 0n && c < 64n) {
          this.gen(e.a)
          count = c.toString()
        } else {
          this.operands(e.a, e.b, false)
          count = 'cl'
        }
        if (e.op === '<<') this.emit(`shl ${acc}, ${count}`)
        else {
          this.note(unsigned ? 'shr' : 'sar')
          this.emit(`${unsigned ? 'shr' : 'sar'} ${acc}, ${count}`, unsigned ? 'unsigned: shift in zeros' : 'signed: shift in copies of the sign bit')
        }
        return
      }
    }
  }

  divide(w: number, unsigned: boolean, divisor: string) {
    if (unsigned) {
      this.note('div')
      this.emit('xor edx, edx', 'unsigned: upper half of the dividend = 0')
      this.emit(`div ${divisor}`, 'quotient → eax, remainder → edx')
    } else {
      this.note('idiv')
      this.emit(w === 8 ? 'cqo' : 'cdq', `signed: sign-extend ${w === 8 ? 'rax into rdx:rax' : 'eax into edx:eax'}`)
      this.emit(`idiv ${divisor}`, 'quotient → eax, remainder → edx')
    }
  }

  assign(e: Extract<Expr, { k: 'assign' }>) {
    const tt = e.target.type
    const mem0 = this.direct(e.target)
    if (e.op === '=') {
      if (mem0) {
        this.gen(e.value)
        this.store(tt, mem0, e.target.k === 'var' ? `${e.target.sym.name} = ...` : undefined)
        return
      }
      this.genAddr(e.target)
      this.emit('push rax', 'save the target address')
      this.depth++
      this.gen(e.value)
      this.pop('rcx', 'target address')
      this.store(tt, '[rcx]')
      return
    }
    // compound assignment: target = target op value
    const opT = e.opType!
    const w = width(opT)
    let mem = mem0
    if (mem) {
      this.gen(e.value)
      this.emit(`mov ${cName(width(e.value.type))}, ${accName(width(e.value.type))}`, 'right side → rcx')
    } else {
      this.genAddr(e.target)
      this.emit('push rax', 'save the target address')
      this.depth++
      this.gen(e.value)
      this.emit(`mov ${cName(width(e.value.type))}, ${accName(width(e.value.type))}`, 'right side → rcx')
      this.pop('rdi', 'target address')
      mem = '[rdi]'
    }
    this.load(tt, mem, 'current value')
    if (e.scale) {
      if (e.scale > 1) {
        this.note('ptrScale')
        this.emit(`imul rcx, rcx, ${e.scale}`, `× ${e.scale} bytes per element`)
      }
      this.emit(`${e.op === '+=' ? 'add' : 'sub'} rax, rcx`)
      this.store(tt, mem)
      return
    }
    this.convert(tt, opT)
    const acc = accName(w)
    const unsigned = isUnsigned(opT)
    const c = cName(w)
    switch (e.op) {
      case '+=': this.emit(`add ${acc}, ${c}`); break
      case '-=': this.emit(`sub ${acc}, ${c}`); break
      case '&=': this.emit(`and ${acc}, ${c}`); break
      case '|=': this.emit(`or ${acc}, ${c}`); break
      case '^=': this.emit(`xor ${acc}, ${c}`); break
      case '*=':
        this.note(unsigned ? 'mul' : 'imul')
        this.emit(unsigned ? `mul ${c}` : `imul ${acc}, ${c}`)
        break
      case '/=': case '%=':
        this.divide(w, unsigned, c)
        if (e.op === '%=') this.emit(`mov ${acc}, ${w === 8 ? 'rdx' : 'edx'}`)
        break
      case '<<=': this.emit(`shl ${acc}, cl`); break
      case '>>=':
        this.note(unsigned ? 'shr' : 'sar')
        this.emit(`${unsigned ? 'shr' : 'sar'} ${acc}, cl`)
        break
    }
    this.convert(opT, tt)
    this.store(tt, mem)
  }

  call(e: Extract<Expr, { k: 'call' }>) {
    const n = e.args.length
    if (n) this.note('argRegs')
    for (const a of e.args) {
      this.gen(a)
      this.emit('push rax', 'argument')
      this.depth++
    }
    for (let i = n - 1; i >= 0; i--) this.pop(ARG64[i], `argument ${i + 1}`)
    const misaligned = this.depth % 2 === 1
    if (misaligned) {
      this.note('callAlign')
      this.emit('sub rsp, 8', 'keep rsp 16-byte aligned for the call (ABI)')
    }
    this.emit(`call ${asmName(e.fn.name)}`)
    if (misaligned) this.emit('add rsp, 8')
    const rt = e.type
    if (rt.k === 'int' && rt.size < 4) {
      const signed = !rt.unsigned
      this.note(signed ? 'movsx' : 'movzx')
      this.emit(`${signed ? 'movsx' : 'movzx'} eax, ${rt.size === 1 ? 'al' : 'ax'}`, 'extend the return value')
    }
    if (rt.k !== 'void') this.note('retReg')
  }

  /** Convert the value in RAX from one type to another. Types disappear: only sizes remain. */
  convert(from: CType, to: CType) {
    if (to.k === 'void') return
    const f = decay(from)
    const fs = sizeOf(f)
    const ts = sizeOf(to)
    const fSigned = isInt(f) && !f.unsigned
    const tSigned = isInt(to) && !to.unsigned
    if (ts === 8) {
      if (fs === 8) return
      if (fSigned) {
        this.note('movsxd')
        this.emit('movsxd rax, eax', `${typeName(f)} → ${typeName(to)}: sign-extend to 64 bits`)
      } else this.note('zeroExt32')
      return
    }
    if (ts === 4) {
      if (fs === 8) this.note('truncate')
      return
    }
    // to char / short: the value must fit, otherwise keep only the low bytes and re-extend
    const subset = (fs < ts && (tSigned || !fSigned)) || (fs === ts && fSigned === tSigned)
    if (subset) return
    this.note(fs > ts ? 'truncate' : tSigned ? 'movsx' : 'movzx')
    this.emit(`${tSigned ? 'movsx' : 'movzx'} eax, ${ts === 1 ? 'al' : 'ax'}`, `→ ${typeName(to)}: keep the low ${ts * 8} bits`)
  }

  /** Jump to `label` if the condition is true (jumpIf) or false. Comparisons jump directly. */
  branch(e: Expr, label: string, jumpIf: boolean) {
    const inv: Record<string, string> = { e: 'ne', ne: 'e', l: 'ge', ge: 'l', g: 'le', le: 'g', b: 'ae', ae: 'b', a: 'be', be: 'a' }
    const cmpOps: Record<string, [string, string]> = { '<': ['l', 'b'], '>': ['g', 'a'], '<=': ['le', 'be'], '>=': ['ge', 'ae'], '==': ['e', 'e'], '!=': ['ne', 'ne'] }
    if (e.k === 'binary' && e.op in cmpOps && !e.scale && !e.ptrDiff) {
      const unsigned = isUnsigned(e.a.type)
      const b = this.operands(e.a, e.b)
      let cc = cmpOps[e.op][unsigned ? 1 : 0]
      if (!jumpIf) cc = inv[cc]
      if (e.op !== '==' && e.op !== '!=') this.note(unsigned ? 'cmpUnsigned' : 'cmpSigned')
      this.emit(`cmp ${accName(width(e.a.type))}, ${b}`)
      this.emit(`j${cc} ${label}`, `${jumpIf ? 'if' : 'unless'} ${e.op}${e.op !== '==' && e.op !== '!=' ? (unsigned ? ' (unsigned)' : ' (signed)') : ''}`)
      return
    }
    if (e.k === 'logical') {
      this.note('shortCircuit')
      const and = e.op === '&&'
      if (and !== jumpIf) {
        // && jumping when false / || jumping when true: either operand decides alone
        this.branch(e.a, label, jumpIf)
        this.branch(e.b, label, jumpIf)
      } else {
        const skip = this.newLabel(and ? 'and_skip' : 'or_skip')
        this.branch(e.a, skip, !jumpIf)
        this.branch(e.b, label, jumpIf)
        this.label(skip)
      }
      return
    }
    if (e.k === 'unary' && e.op === '!') {
      this.branch(e.e, label, !jumpIf)
      return
    }
    const c = constValue(e)
    if (c !== null) {
      if ((c !== 0n) === jumpIf) this.emit(`jmp ${label}`, 'constant condition')
      return
    }
    this.gen(e)
    this.emit(`cmp ${accName(width(e.type))}, 0`)
    this.emit(`${jumpIf ? 'jne' : 'je'} ${label}`, jumpIf ? 'if not 0 (true)' : 'if 0 (false)')
  }
}

function fitsImm32(v: bigint): boolean {
  return v >= -0x80000000n && v <= 0x7fffffffn
}

function printable(bytes: number[]): string {
  return bytes.map((b) => (b === 10 ? '\\n' : b === 9 ? '\\t' : b === 34 ? '\\"' : b >= 32 && b < 127 ? String.fromCharCode(b) : `\\x${b.toString(16)}`)).join('')
}

function charText(b: number): string {
  return b >= 32 && b < 127 && b !== 39 ? `'${String.fromCharCode(b)}'` : String(b)
}

/** `db "Hello", 10, 0`: printable runs as strings, everything else as numbers. */
export function dbList(bytes: number[]): string {
  const parts: string[] = []
  let run = ''
  for (const b of bytes) {
    if (b >= 32 && b < 127 && b !== 34 && b !== 39 && b !== 96) run += String.fromCharCode(b)
    else {
      if (run) parts.push(`"${run}"`)
      run = ''
      parts.push(String(b))
    }
  }
  if (run) parts.push(`"${run}"`)
  return 'db ' + (parts.length ? parts.join(', ') : '0')
}

/** The condition part of `while (...)` for comments. */
function exprText(line: string, kw: string): string {
  const m = new RegExp(`${kw}\\s*\\((.*)\\)`).exec(line)
  return m ? m[1] : line
}
