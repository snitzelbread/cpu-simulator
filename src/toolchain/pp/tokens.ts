/**
 * Preprocessor pass 2 (lecture model): split each line into preprocessing tokens.
 * The tokenizer is greedy: it always takes the longest token that fits, so `a+++++b`
 * becomes `a ++ ++ + b`, and `0xE+12` or `123.X` are single preprocessor numbers.
 */
import type { Diagnostic } from '../diagnostics'

export type TokKind = 'ident' | 'number' | 'string' | 'char' | 'punct' | 'header' | 'other'

export interface PPToken {
  kind: TokKind
  text: string
  file: string
  /** 1-based line and column in the source after pass 1. */
  line: number
  col: number
  /** Whitespace before this token (matters for output spacing and `#` stringification). */
  space: boolean
  /** Macro names this token must not be replaced by again (Prosser's hide set). */
  hide?: Set<string>
  /** "Painted blue": a macro name met inside its own expansion; it is never replaced. */
  painted?: boolean
  /** Name of the macro whose expansion produced the token. */
  fromMacro?: string
}

/** All C punctuators, longest first so greedy matching works by trying them in order. */
export const PUNCTUATORS = [
  '%:%:', '...', '<<=', '>>=',
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '*=', '/=', '%=', '+=', '-=',
  '&=', '^=', '|=', '##', '<:', ':>', '<%', '%>', '%:',
  '[', ']', '(', ')', '{', '}', '.', '&', '*', '+', '-', '~', '!', '/', '%', '<', '>', '^', '|',
  '?', ':', ';', '=', ',', '#',
]

const DIGRAPHS: Record<string, string> = { '<:': '[', ':>': ']', '<%': '{', '%>': '}', '%:': '#', '%:%:': '##' }

/** The punctuator a digraph stands for (`<:` is `[`), otherwise the text itself. */
export function canonical(text: string): string {
  return DIGRAPHS[text] ?? text
}

const PP_NUMBER = /^\.?[0-9](?:[eEpP][+-]|[0-9A-Za-z_.])*/
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/
const STR_PREFIX = /^(?:u8|u|U|L)?(["'])/

export interface TokenizeResult {
  tokens: PPToken[]
  errors: Diagnostic[]
}

/** Tokenize one line. `headerName`: after `#include`, `<...>` is one header-name token. */
export function tokenizeLine(file: string, lineNo: number, text: string): TokenizeResult {
  const tokens: PPToken[] = []
  const errors: Diagnostic[] = []
  let i = 0
  let space = false
  const push = (kind: TokKind, len: number) => {
    tokens.push({ kind, text: text.slice(i, i + len), file, line: lineNo, col: i + 1, space })
    i += len
    space = false
  }
  while (i < text.length) {
    const rest = text.slice(i)
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') {
      space = true
      i++
      continue
    }
    // header name, only directly after "# include"
    if (c === '<' && isIncludeLine(tokens)) {
      const end = text.indexOf('>', i)
      if (end > 0) {
        push('header', end - i + 1)
        continue
      }
    }
    const sp = STR_PREFIX.exec(rest)
    if (sp) {
      const q = sp[1]
      let k = sp[0].length
      while (k < rest.length && rest[k] !== q) k += rest[k] === '\\' ? 2 : 1
      if (k >= rest.length) {
        errors.push({ stage: 'pp', code: q === '"' ? 'unterminatedString' : 'unterminatedChar', file, line: lineNo, col: i + 1 })
        push('other', rest.length)
        continue
      }
      push(q === '"' ? 'string' : 'char', k + 1)
      continue
    }
    const num = PP_NUMBER.exec(rest)
    if (num) {
      push('number', num[0].length)
      continue
    }
    const id = IDENT.exec(rest)
    if (id) {
      push('ident', id[0].length)
      continue
    }
    const p = PUNCTUATORS.find((x) => rest.startsWith(x))
    if (p) {
      push('punct', p.length)
      continue
    }
    push('other', 1)
  }
  return { tokens, errors }
}

function isIncludeLine(tokens: PPToken[]): boolean {
  return tokens.length === 2 && canonical(tokens[0].text) === '#' && tokens[1].text === 'include'
}

/** Tokenize all lines (after pass 1). */
export function pass2(file: string, lines: string[]): { lines: PPToken[][]; errors: Diagnostic[] } {
  const errors: Diagnostic[] = []
  const out = lines.map((l, i) => {
    const r = tokenizeLine(file, i + 1, l)
    errors.push(...r.errors)
    return r.tokens
  })
  return { lines: out, errors }
}

/** Join tokens back into text, with a space where the source had whitespace. */
export function tokensText(toks: PPToken[]): string {
  let s = ''
  toks.forEach((t, i) => {
    if (i > 0 && (t.space || needsSpace(toks[i - 1], t))) s += ' '
    s += t.text
  })
  return s
}

/** Avoid accidentally gluing tokens together in output (e.g. `+` `+` must not print as `++`). */
function needsSpace(a: PPToken, b: PPToken): boolean {
  const word = (t: PPToken) => t.kind === 'ident' || t.kind === 'number'
  if (word(a) && word(b)) return true
  if (a.kind === 'punct' && b.kind === 'punct') return PUNCTUATORS.some((p) => p.length > 1 && (a.text + b.text).startsWith(p) && p.length > a.text.length)
  if (a.kind === 'number' && (b.text.startsWith('.') || /^[+-]/.test(b.text))) return /[eEpP]$/.test(a.text) || b.text.startsWith('.')
  return false
}
