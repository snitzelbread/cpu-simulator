/**
 * Evaluates the controlling expression of `#if` / `#elif` (after `defined` and macro
 * replacement). Arithmetic is done in 64 bits (intmax_t), as the C standard requires.
 */
import { DiagnosticError } from '../diagnostics'
import type { PPToken } from './tokens'
import { canonical } from './tokens'

const BIN: [string[], number][] = [
  [['||'], 1], [['&&'], 2], [['|'], 3], [['^'], 4], [['&'], 5], [['==', '!='], 6],
  [['<', '>', '<=', '>='], 7], [['<<', '>>'], 8], [['+', '-'], 9], [['*', '/', '%'], 10],
]

const wrap = (v: bigint) => BigInt.asIntN(64, v)

export function evalIfExpr(toks: PPToken[]): bigint {
  let pos = 0
  const t0 = toks[0]
  const err = (code: string, params?: Record<string, string>): never => {
    const t = toks[Math.min(pos, toks.length - 1)] ?? t0
    throw new DiagnosticError({ stage: 'pp', code, params, file: t?.file, line: t?.line })
  }
  const peek = () => (pos < toks.length ? canonical(toks[pos].text) : undefined)

  const primary = (): bigint => {
    const t = toks[pos]
    if (!t) return err('ifSyntax')
    const s = canonical(t.text)
    if (s === '(') {
      pos++
      const v = cond()
      if (peek() !== ')') err('ifSyntax')
      pos++
      return v
    }
    if (s === '-' || s === '+' || s === '~' || s === '!') {
      pos++
      const v = primary()
      return s === '-' ? wrap(-v) : s === '+' ? v : s === '~' ? wrap(~v) : v === 0n ? 1n : 0n
    }
    pos++
    if (t.kind === 'number') {
      const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)([uU]?[lL]{0,2}|[lL]{0,2}[uU]?)$/.exec(t.text)
      if (!m) err('ifBadNumber', { text: t.text })
      const d = m![1]
      const v = /^0[bB]/.test(d) ? BigInt(d) : /^0[0-7]+$/.test(d) ? BigInt('0o' + d.slice(1)) : BigInt(d)
      return wrap(v)
    }
    if (t.kind === 'char') {
      const inner = t.text.replace(/^[uUL]?'/, '').slice(0, -1)
      return BigInt(charValue(inner))
    }
    if (t.kind === 'ident') return 0n // identifiers left after macro replacement are 0
    return err('ifSyntax')
  }

  const binary = (level: number): bigint => {
    if (level === BIN.length) return primary()
    let a = binary(level + 1)
    for (;;) {
      const op = peek()
      if (!op || !BIN[level][0].includes(op)) return a
      pos++
      // short circuit is irrelevant for values, but division by zero in a dead branch is fine in C
      const b = binary(level + 1)
      a = apply(op, a, b)
    }
  }

  const apply = (op: string, a: bigint, b: bigint): bigint => {
    switch (op) {
      case '||': return a || b ? 1n : 0n
      case '&&': return a && b ? 1n : 0n
      case '|': return a | b
      case '^': return a ^ b
      case '&': return a & b
      case '==': return a === b ? 1n : 0n
      case '!=': return a !== b ? 1n : 0n
      case '<': return a < b ? 1n : 0n
      case '>': return a > b ? 1n : 0n
      case '<=': return a <= b ? 1n : 0n
      case '>=': return a >= b ? 1n : 0n
      case '<<': return wrap(a << (b & 63n))
      case '>>': return a >> (b & 63n)
      case '+': return wrap(a + b)
      case '-': return wrap(a - b)
      case '*': return wrap(a * b)
      case '/': if (b === 0n) err('ifDivZero'); return wrap(a / b)
      case '%': if (b === 0n) err('ifDivZero'); return wrap(a % b)
    }
    return err('ifSyntax')
  }

  const cond = (): bigint => {
    const c = binary(0)
    if (peek() !== '?') return c
    pos++
    const a = cond()
    if (peek() !== ':') err('ifSyntax')
    pos++
    const b = cond()
    return c ? a : b
  }

  if (!toks.length) err('ifEmpty')
  const v = cond()
  if (pos < toks.length) err('ifSyntax')
  return v
}

/** Value of a (single) character constant body, e.g. `a`, `\n`, `\x41`. */
export function charValue(body: string): number {
  if (!body.startsWith('\\')) return body.charCodeAt(0)
  const e = body[1]
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11, '?': 63 }
  if (e === 'x') return (parseInt(body.slice(2), 16) || 0) & 0xff
  if (/[0-7]/.test(e)) return parseInt(body.slice(1, 4).match(/^[0-7]+/)![0], 8) & 0xff
  return simple[e] ?? e.charCodeAt(0)
}
