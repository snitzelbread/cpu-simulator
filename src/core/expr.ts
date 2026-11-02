import { fail } from './errors'
import type { Token } from './lexer'
import { lookupRegister, type RegInfo } from './registers'

export type Expr =
  | { k: 'num'; v: bigint }
  | { k: 'sym'; name: string }
  | { k: 'reg'; reg: RegInfo }
  | { k: 'here' }
  | { k: 'start' }
  | { k: 'un'; op: string; e: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }

const LEVELS: string[][] = [['|'], ['^'], ['&'], ['<<', '>>'], ['+', '-'], ['*', '/', '%']]

/** Character constants are little-endian: 'ab' = 0x6261 (NASM semantics). */
export function charConstant(bytes: number[]): bigint {
  if (bytes.length > 8) fail('immOutOfRange', { value: 'string' })
  let v = 0n
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i])
  return v
}

export class ExprParser {
  pos = 0
  constructor(
    private toks: Token[],
    private qualify: (name: string) => string,
  ) {}

  peek(): Token | undefined {
    return this.toks[this.pos]
  }

  atOp(v: string): boolean {
    const t = this.toks[this.pos]
    return !!t && t.t === 'op' && t.v === v
  }

  parse(level = 0): Expr {
    if (level === LEVELS.length) return this.unary()
    let a = this.parse(level + 1)
    for (;;) {
      const t = this.peek()
      if (t && t.t === 'op' && LEVELS[level].includes(t.v)) {
        this.pos++
        const b = this.parse(level + 1)
        a = { k: 'bin', op: t.v, a, b }
      } else return a
    }
  }

  private unary(): Expr {
    const t = this.peek()
    if (!t) fail('syntax')
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '~')) {
      this.pos++
      return { k: 'un', op: t.v, e: this.unary() }
    }
    this.pos++
    if (t.t === 'num') return { k: 'num', v: t.v }
    if (t.t === 'str') return { k: 'num', v: charConstant(t.v) }
    if (t.t === 'op' && t.v === '$') return { k: 'here' }
    if (t.t === 'op' && t.v === '$$') return { k: 'start' }
    if (t.t === 'op' && t.v === '(') {
      const e = this.parse()
      if (!this.atOp(')')) fail('syntax')
      this.pos++
      return e
    }
    if (t.t === 'id') {
      const reg = lookupRegister(t.v)
      if (reg) return { k: 'reg', reg }
      return { k: 'sym', name: this.qualify(t.v) }
    }
    fail('unexpectedToken', { token: String(t.v) })
  }
}

export interface EvalContext {
  lookup(name: string): bigint | undefined
  here: bigint
  start: bigint
  /** In the final pass unresolved symbols are errors; before, they yield null. */
  final: boolean
  /** True for address labels (as opposed to equ constants). */
  isLabel?: (name: string) => boolean
}

/**
 * Does the expression depend on a section address (label or $)? `label - label` is a
 * plain number again. NASM only uses RIP-relative addressing / imm64 for relocatable values.
 */
export function isRelocatable(e: Expr, ctx: EvalContext): boolean {
  return relocCount(e, ctx) !== 0
}

function relocCount(e: Expr, ctx: EvalContext): number {
  switch (e.k) {
    case 'sym': return ctx.isLabel?.(e.name) ? 1 : 0
    case 'here': case 'start': return 1
    case 'un': return e.op === '-' ? -relocCount(e.e, ctx) : relocCount(e.e, ctx)
    case 'bin': {
      const a = relocCount(e.a, ctx)
      const b = relocCount(e.b, ctx)
      if (e.op === '+') return a + b
      if (e.op === '-') return a - b
      return a || b ? 1 : 0
    }
    default: return 0
  }
}

export function evaluate(e: Expr, ctx: EvalContext): bigint | null {
  switch (e.k) {
    case 'num':
      return e.v
    case 'here':
      return ctx.here
    case 'start':
      return ctx.start
    case 'sym': {
      const v = ctx.lookup(e.name)
      if (v === undefined) {
        if (ctx.final) fail('undefinedSymbol', { name: e.name })
        return null
      }
      return v
    }
    case 'reg':
      fail('notConstant', { name: e.reg.name })
    // eslint-disable-next-line no-fallthrough
    case 'un': {
      const v = evaluate(e.e, ctx)
      if (v === null) return null
      return e.op === '-' ? -v : e.op === '~' ? ~v : v
    }
    case 'bin': {
      const a = evaluate(e.a, ctx)
      const b = evaluate(e.b, ctx)
      if (a === null || b === null) return null
      return binop(e.op, a, b)
    }
  }
}

function binop(op: string, a: bigint, b: bigint): bigint {
  switch (op) {
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': if (b === 0n) fail('divByZeroExpr'); return a / b
    case '%': if (b === 0n) fail('divByZeroExpr'); return a % b
    case '<<': return a << b
    case '>>': return a >> b
    case '&': return a & b
    case '|': return a | b
    case '^': return a ^ b
  }
  fail('syntax')
}

/** A memory-operand expression as constant + Σ coef·register. */
export interface Linear {
  disp: bigint | null
  regs: { reg: RegInfo; coef: bigint }[]
}

export function linearize(e: Expr, ctx: EvalContext): Linear {
  switch (e.k) {
    case 'reg':
      return { disp: 0n, regs: [{ reg: e.reg, coef: 1n }] }
    case 'un': {
      const l = linearize(e.e, ctx)
      if (e.op === '+') return l
      if (e.op === '-') return { disp: l.disp === null ? null : -l.disp, regs: l.regs.map((r) => ({ ...r, coef: -r.coef })) }
      break
    }
    case 'bin': {
      if (e.op === '+' || e.op === '-') {
        const a = linearize(e.a, ctx)
        const b = linearize(e.b, ctx)
        const s = e.op === '+' ? 1n : -1n
        const regs = [...a.regs]
        for (const r of b.regs) {
          const ex = regs.find((x) => x.reg.index === r.reg.index && x.reg.size === r.reg.size)
          if (ex) ex.coef += s * r.coef
          else regs.push({ reg: r.reg, coef: s * r.coef })
        }
        const disp = a.disp === null || b.disp === null ? null : a.disp + s * b.disp
        return { disp, regs: regs.filter((r) => r.coef !== 0n) }
      }
      if (e.op === '*') {
        const a = linearize(e.a, ctx)
        const b = linearize(e.b, ctx)
        if (a.regs.length && b.regs.length) fail('badAddress')
        const [k, l] = a.regs.length ? [b, a] : [a, b]
        if (k.disp === null) {
          if (l.regs.length) {
            if (ctx.final) fail('undefinedSymbol', { name: '?' })
            return { disp: null, regs: l.regs }
          }
          return { disp: null, regs: [] }
        }
        return { disp: l.disp === null ? null : l.disp * k.disp, regs: l.regs.map((r) => ({ ...r, coef: r.coef * k.disp! })) }
      }
      break
    }
  }
  if (containsReg(e)) fail('badAddress')
  return { disp: evaluate(e, ctx), regs: [] }
}

export function containsReg(e: Expr): boolean {
  if (e.k === 'reg') return true
  if (e.k === 'un') return containsReg(e.e)
  if (e.k === 'bin') return containsReg(e.a) || containsReg(e.b)
  return false
}
