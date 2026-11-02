import { AsmException, fail, type AsmError } from './errors'
import { ExprParser, type Expr } from './expr'
import { decodeMnemonic, KNOWN_UNSUPPORTED, suggestMnemonic, type DecodedMnemonic } from './isa'
import { stripComment, tokenize, type Token } from './lexer'
import { lookupRegister, type RegInfo } from './registers'
import type { Size } from './util'

export type OperandAst =
  | { k: 'reg'; reg: RegInfo; text: string }
  | { k: 'mem'; size?: Size; expr: Expr; rel?: boolean; text: string }
  | { k: 'imm'; size?: Size; expr: Expr; text: string }

export type DataItem = { k: 'expr'; e: Expr } | { k: 'str'; bytes: number[] }

export type Stmt =
  | { kind: 'label'; name: string; line: number }
  | { kind: 'instr'; mnemonic: string; dec: DecodedMnemonic; operands: OperandAst[]; line: number; text: string }
  | { kind: 'data'; unit: Size; items: DataItem[]; times?: Expr; line: number }
  | { kind: 'res'; unit: Size; count: Expr; line: number }
  | { kind: 'equ'; name: string; expr: Expr; line: number }
  | { kind: 'section'; name: 'text' | 'data' | 'bss'; line: number }
  | { kind: 'global'; names: string[]; line: number }
  | { kind: 'extern'; names: string[]; line: number }
  | { kind: 'default'; rel: boolean; line: number }

export interface ParseResult {
  stmts: Stmt[]
  errors: AsmError[]
}

const SIZE_KW: Record<string, Size> = { byte: 1, word: 2, dword: 4, qword: 8 }
const DATA_KW: Record<string, Size> = { db: 1, dw: 2, dd: 4, dq: 8 }
const RES_KW: Record<string, Size> = { resb: 1, resw: 2, resd: 4, resq: 8 }
const UNSUPPORTED_DIRECTIVES = new Set([
  'org', 'align', 'alignb', 'dt', 'ddq', 'do', 'dy', 'dz', 'rest', 'reso', 'incbin',
  'common', 'static', 'cpu', 'struc', 'endstruc', 'istruc', 'at', 'iend', 'absolute', 'use16', 'use32',
])

function isDirectiveWord(v: string): boolean {
  const s = v.toLowerCase()
  return s in DATA_KW || s in RES_KW || s === 'equ' || s === 'times'
}

/** Split tokens at top-level commas. */
function splitCommas(toks: Token[]): Token[][] {
  const parts: Token[][] = [[]]
  let depth = 0
  for (const t of toks) {
    if (t.t === 'op' && (t.v === '[' || t.v === '(')) depth++
    if (t.t === 'op' && (t.v === ']' || t.v === ')')) depth--
    if (t.t === 'op' && t.v === ',' && depth === 0) parts.push([])
    else parts[parts.length - 1].push(t)
  }
  return parts
}

function tokText(toks: Token[]): string {
  return toks
    .map((t) => (t.t === 'str' ? `'${String.fromCharCode(...t.v)}'` : t.t === 'num' ? String(t.v) : t.v))
    .join(' ')
}

class LineParser {
  constructor(
    private qualify: (name: string) => string,
    private srcText: string,
  ) {}

  expr(toks: Token[]): Expr {
    if (!toks.length) fail('syntax')
    const p = new ExprParser(toks, this.qualify)
    const e = p.parse()
    if (p.pos !== toks.length) fail('unexpectedToken', { token: String(toks[p.pos].v) })
    return e
  }

  operand(toks: Token[]): OperandAst {
    if (!toks.length) fail('syntax')
    let size: Size | undefined
    let i = 0
    const first = toks[0]
    if (first.t === 'id' && !first.raw && first.v.toLowerCase() in SIZE_KW) {
      size = SIZE_KW[first.v.toLowerCase()]
      i = 1
      const nxt = toks[1]
      if (nxt && nxt.t === 'id' && nxt.v.toLowerCase() === 'ptr') fail('ptrKeyword')
    }
    const rest = toks.slice(i)
    const text = this.slice(toks)
    if (!rest.length) fail('syntax')
    if (rest[0].t === 'op' && rest[0].v === '[') {
      const last = rest[rest.length - 1]
      if (!(last.t === 'op' && last.v === ']')) fail('syntax')
      let inner = rest.slice(1, -1)
      let rel: boolean | undefined
      const kw = inner[0]
      if (kw && kw.t === 'id' && !kw.raw && ['rel', 'abs'].includes(kw.v.toLowerCase())) {
        rel = kw.v.toLowerCase() === 'rel'
        inner = inner.slice(1)
      }
      if (inner.length >= 2 && inner[1].t === 'op' && inner[1].v === ':') fail('segmentOverride')
      return { k: 'mem', size, expr: this.expr(inner), rel, text }
    }
    if (rest.length === 1 && rest[0].t === 'id' && !rest[0].raw) {
      const reg = lookupRegister(rest[0].v)
      if (reg) {
        if (size && size !== reg.size) fail('sizeMismatch')
        return { k: 'reg', reg, text }
      }
    }
    return { k: 'imm', size, expr: this.expr(rest), text }
  }

  private slice(toks: Token[]): string {
    const start = toks[0].col - 1
    const lastTok = toks[toks.length - 1]
    // find end of last token in the source text
    let end = lastTok.col - 1
    if (lastTok.t === 'str') {
      const q = this.srcText[end]
      end = this.srcText.indexOf(q, end + 1) + 1
    } else {
      const m = this.srcText.slice(end).match(/^([A-Za-z0-9_.?@$#~]+|<<|>>|\$\$|.)/)
      end += m ? m[0].length : 1
    }
    return this.srcText.slice(start, end).trim()
  }

  data(unit: Size, toks: Token[], line: number, times?: Expr): Stmt {
    const items: DataItem[] = splitCommas(toks).map((part) => {
      if (part.length === 1 && part[0].t === 'str' && (unit === 1 || part[0].v.length > unit)) {
        return { k: 'str', bytes: part[0].v }
      }
      if (part.length === 1 && part[0].t === 'str') return { k: 'str', bytes: part[0].v }
      return { k: 'expr', e: this.expr(part) }
    })
    return { kind: 'data', unit, items, times, line }
  }
}

export function parse(source: string): ParseResult {
  const stmts: Stmt[] = []
  const errors: AsmError[] = []
  let lastGlobal = ''
  const qualify = (name: string) => (name.startsWith('.') && !name.startsWith('..') ? lastGlobal + name : name)

  source.split('\n').forEach((raw, idx) => {
    const line = idx + 1
    const text = stripComment(raw)
    if (!text.trim()) return
    try {
      let toks = tokenize(text)
      const lp = new LineParser(qualify, text)
      // [bits 64] / [default rel] style
      if (toks[0]?.t === 'op' && toks[0].v === '[' && toks[toks.length - 1]?.t === 'op' && toks[toks.length - 1].v === ']') {
        toks = toks.slice(1, -1)
      }
      // label
      const defineLabel = (name: string) => {
        if (!name.startsWith('.')) lastGlobal = name
        const q = qualify(name)
        stmts.push({ kind: 'label', name: q, line })
        return q
      }
      let labelName: string | undefined
      if (toks.length >= 2 && toks[0].t === 'id' && toks[1].t === 'op' && toks[1].v === ':' && (toks[0].raw || !lookupRegister(toks[0].v))) {
        const name0 = toks[0].v
        toks = toks.slice(2)
        if (toks[0]?.t === 'id' && toks[0].v.toLowerCase() === 'equ') {
          labelName = name0
        } else labelName = defineLabel(name0)
      } else if (
        toks.length >= 2 && toks[0].t === 'id' && toks[1].t === 'id' && isDirectiveWord(toks[1].v) &&
        !decodeMnemonic(toks[0].v) && !lookupRegister(toks[0].v)
      ) {
        // label without colon before data / equ
        const name0 = toks[0].v
        toks = toks.slice(1)
        if (toks[0].t === 'id' && toks[0].v.toLowerCase() === 'equ') labelName = name0
        else labelName = defineLabel(name0)
      }
      if (!toks.length) return
      const head = toks[0]
      if (head.t !== 'id') fail('syntax')
      const word = head.v.toLowerCase()
      const args = toks.slice(1)

      if (word === 'equ') {
        if (!labelName) fail('badEqu')
        if (!labelName.startsWith('.')) lastGlobal = labelName
        stmts.push({ kind: 'equ', name: qualify(labelName), expr: lp.expr(args), line })
        return
      }
      if (word === 'bits') {
        if (args.length !== 1 || args[0].t !== 'num' || args[0].v !== 64n) fail('unsupportedDirective', { name: tokText(toks) })
        return
      }
      if (word === 'global' || word === 'extern') {
        stmts.push({ kind: word, names: args.filter((t) => t.t === 'id').map((t) => String(t.v)), line })
        return
      }
      if (word === 'default') {
        const a = args[0]
        if (!a || a.t !== 'id' || !['rel', 'abs'].includes(a.v.toLowerCase())) fail('syntax')
        stmts.push({ kind: 'default', rel: a.v.toLowerCase() === 'rel', line })
        return
      }
      if (word === 'section' || word === 'segment') {
        const n = args[0]
        if (!n || n.t !== 'id') fail('syntax')
        const s = n.v.toLowerCase()
        const name = s === '.text' ? 'text' : s === '.data' || s === '.rodata' ? 'data' : s === '.bss' ? 'bss' : null
        if (!name) fail('unsupportedDirective', { name: `section ${n.v}` })
        stmts.push({ kind: 'section', name, line })
        return
      }
      if (word in DATA_KW) {
        stmts.push(lp.data(DATA_KW[word], args, line))
        return
      }
      if (word in RES_KW) {
        stmts.push({ kind: 'res', unit: RES_KW[word], count: lp.expr(args), line })
        return
      }
      if (word === 'times') {
        // times <count> db ...
        const k = args.findIndex((t) => t.t === 'id' && t.v.toLowerCase() in DATA_KW)
        if (k < 1) fail('unsupportedDirective', { name: 'times' })
        const count = lp.expr(args.slice(0, k))
        stmts.push(lp.data(DATA_KW[String(args[k].v).toLowerCase()], args.slice(k + 1), line, count))
        return
      }
      if (UNSUPPORTED_DIRECTIVES.has(word)) fail('unsupportedDirective', { name: head.v })

      const dec = decodeMnemonic(word)
      if (!dec) {
        if (KNOWN_UNSUPPORTED.has(word)) fail('unsupportedInstruction', { name: head.v })
        const sug = suggestMnemonic(word)
        fail('unknownInstruction', sug ? { name: head.v, suggestion: sug } : { name: head.v })
      }
      const operands = args.length ? splitCommas(args).map((p) => lp.operand(p)) : []
      const instrText = text.slice(head.col - 1).trim().replace(/\s+/g, ' ')
      stmts.push({ kind: 'instr', mnemonic: word, dec, operands, line, text: instrText })
    } catch (e) {
      if (e instanceof AsmException) errors.push({ line, code: e.code, params: e.params })
      else throw e
    }
  })
  return { stmts, errors }
}
