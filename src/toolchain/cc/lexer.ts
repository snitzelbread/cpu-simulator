/** Turns the preprocessor's tokens into C tokens (keywords, typed constants, decoded strings). */
import { DiagnosticError } from '../diagnostics'
import { charValue } from '../pp/ifexpr'
import { canonical, type PPToken } from '../pp/tokens'
import { INT, LONG, UINT, ULONG, type CType } from './types'

export interface Loc {
  file: string
  line: number
  col: number
}

export type CToken =
  | { k: 'ident'; text: string; loc: Loc }
  | { k: 'keyword'; text: string; loc: Loc }
  | { k: 'punct'; text: string; loc: Loc }
  | { k: 'num'; text: string; value: bigint; type: CType; loc: Loc }
  | { k: 'str'; text: string; bytes: number[]; loc: Loc }
  | { k: 'eof'; text: ''; loc: Loc }

export const KEYWORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'unsigned', 'signed', 'if', 'else', 'while', 'do', 'for',
  'break', 'continue', 'return', 'sizeof', 'extern', 'static', 'const', 'volatile',
  // recognised so they can be rejected with a clear message
  'struct', 'union', 'enum', 'typedef', 'switch', 'case', 'default', 'goto', 'float', 'double',
  'auto', 'register', 'inline', 'restrict', '_Bool', '_Complex',
])

export function lex(tokens: PPToken[]): CToken[] {
  const out: CToken[] = []
  for (const t of tokens) {
    const loc: Loc = { file: t.file, line: t.line, col: t.col }
    switch (t.kind) {
      case 'ident':
        out.push({ k: KEYWORDS.has(t.text) ? 'keyword' : 'ident', text: t.text, loc })
        break
      case 'punct':
        out.push({ k: 'punct', text: canonical(t.text), loc })
        break
      case 'number':
        out.push(number(t.text, loc))
        break
      case 'char': {
        if (!t.text.startsWith("'")) throw err('wideChar', loc, { text: t.text })
        const body = t.text.slice(1, -1)
        if (!body.length) throw err('emptyChar', loc)
        const v = charValue(body)
        // char is signed on x86-64: '\xff' is -1
        out.push({ k: 'num', text: t.text, value: BigInt(v > 127 ? v - 256 : v), type: INT, loc })
        break
      }
      case 'string': {
        if (!t.text.startsWith('"')) throw err('wideString', loc, { text: t.text })
        const bytes = decodeString(t.text.slice(1, -1))
        const prev = out[out.length - 1]
        // adjacent string literals are joined: "ab" "cd" == "abcd"
        if (prev?.k === 'str') {
          prev.bytes.push(...bytes)
          prev.text = prev.text.slice(0, -1) + t.text.slice(1)
        } else out.push({ k: 'str', text: t.text, bytes, loc })
        break
      }
      default:
        throw err('unexpectedChar', loc, { text: t.text })
    }
  }
  const last = tokens[tokens.length - 1]
  out.push({ k: 'eof', text: '', loc: last ? { file: last.file, line: last.line, col: last.col + last.text.length } : { file: '', line: 1, col: 1 } })
  return out
}

function err(code: string, loc: Loc, params?: Record<string, string>) {
  return new DiagnosticError({ stage: 'cc', code, file: loc.file, line: loc.line, col: loc.col, params })
}

function number(text: string, loc: Loc): CToken {
  const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)([uU]?(?:ll|LL|l|L)?|(?:ll|LL|l|L)[uU])$/.exec(text)
  if (!m) {
    if (isFloat(text)) throw err('floatUnsupported', loc, { text })
    // e.g. 0xE+12 or 123.X: one preprocessor number, but not a valid C constant
    throw err('invalidPPNumber', loc, { text })
  }
  const digits = m[1]
  const suffix = m[2].toLowerCase()
  const decimal = !/^0/.test(digits) || digits === '0'
  const value = /^0[0-7]+$/.test(digits) ? BigInt('0o' + digits.slice(1)) : BigInt(digits)
  const u = suffix.includes('u')
  const l = suffix.includes('l')
  // C11 6.4.4.1: the first type that can represent the value
  const candidates: CType[] = u ? (l ? [ULONG] : [UINT, ULONG]) : l ? (decimal ? [LONG] : [LONG, ULONG]) : decimal ? [INT, LONG] : [INT, UINT, LONG, ULONG]
  const fits = (t: CType) => {
    const it = t as Extract<CType, { k: 'int' }>
    const bits = BigInt(it.size * 8)
    return value < (it.unsigned ? 1n << bits : 1n << (bits - 1n))
  }
  const type = candidates.find(fits)
  if (!type) throw err('numberTooLarge', loc, { text })
  return { k: 'num', text, value, type, loc }
}

const FLOAT_DEC = /^(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?[fFlL]?$|^\d+[eE][+-]?\d+[fFlL]?$/
const FLOAT_HEX = /^0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)[pP][+-]?\d+[fFlL]?$/

export function isFloat(text: string): boolean {
  return FLOAT_DEC.test(text) || FLOAT_HEX.test(text)
}

export function decodeString(body: string): number[] {
  const out: number[] = []
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      const code = c.charCodeAt(0)
      if (code < 128) out.push(code)
      else out.push(...new TextEncoder().encode(c))
      continue
    }
    const e = body[i + 1]
    if (e === 'x') {
      const m = /^[0-9a-fA-F]*/.exec(body.slice(i + 2))![0]
      out.push(m ? parseInt(m, 16) & 0xff : 0)
      i += 1 + m.length
    } else if (/[0-7]/.test(e)) {
      const m = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0]
      out.push(parseInt(m, 8) & 0xff)
      i += m.length
    } else {
      out.push(charValue('\\' + e))
      i++
    }
  }
  return out
}
