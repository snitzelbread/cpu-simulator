/**
 * Preprocessor pass 3 (lecture model): execute directives and replace macros.
 *
 * Every rewrite is recorded as a step, so the UI can replay it: `int y = ABC;` →
 * `int y = XYZ;` → `int y = 123;`. Macro replacement uses hide sets (Prosser's
 * algorithm, as in real compilers): a macro name inside its own expansion is "painted"
 * and never replaced again.
 */
import { DiagnosticError, type Diagnostic } from '../diagnostics'
import { SYSTEM_HEADERS, type Project } from '../project'
import { evalIfExpr } from './ifexpr'
import { pass1, type Pass1Result } from './pass1'
import { canonical, pass2, tokenizeLine, tokensText, type PPToken } from './tokens'

export interface Macro {
  name: string
  /** Parameter names; undefined for object-like macros. */
  params?: string[]
  body: PPToken[]
  file: string
  line: number
}

export interface OutLine {
  tokens: PPToken[]
  text: string
  /** Source file and line this output line came from. */
  file: string
  line: number
  /** Include nesting depth (0 = the .c file itself). */
  depth: number
  kind: 'text' | 'directive' | 'skipped'
  /** True if a macro was replaced on this line. */
  expanded: boolean
}

interface StepBase {
  file: string
  line: number
  /** Output lines produced up to and including this step. */
  outCount: number
}

export type PPStep = StepBase &
  (
    | { kind: 'define'; macro: Macro; redefined: boolean }
    | { kind: 'undef'; name: string; existed: boolean }
    | { kind: 'cond'; directive: 'if' | 'ifdef' | 'ifndef' | 'elif' | 'else' | 'endif'; expr?: string; value?: string; taken: boolean }
    | { kind: 'include'; target: string; system: boolean; resolved: string; skipped?: 'once' }
    | { kind: 'includeEnd'; target: string }
    | {
        kind: 'expand'
        macro: string
        functionLike: boolean
        /** Tokens of the whole line before and after this one replacement. */
        before: PPToken[]
        after: PPToken[]
        /** Replaced range in `before` and the produced range in `after` (half-open). */
        from: [number, number]
        to: [number, number]
        args?: string[]
        /** Inside an argument that is replaced before it is substituted. */
        inArg?: boolean
      }
    | { kind: 'blocked'; macro: string; tokens: PPToken[]; index: number }
    | { kind: 'ppnumber'; token: string; name: string }
    | { kind: 'pragma'; text: string }
  )

export interface PPResult {
  /** The translation unit (`clang -E`), one entry per output line. */
  lines: OutLine[]
  /** All tokens of the translation unit, for the compiler. */
  tokens: PPToken[]
  steps: PPStep[]
  errors: Diagnostic[]
  /** Pass 1 / pass 2 of the main file, for their own views. */
  pass1: Pass1Result
  pass2: PPToken[][]
  /** Macros defined at the end. */
  macros: Map<string, Macro>
  /** Files included (transitively), in order. */
  includes: string[]
}

const MAX_INCLUDE_DEPTH = 40
const MAX_EXPANSIONS = 20000

interface Cond {
  /** This group is being compiled. */
  active: boolean
  /** Some earlier group of this if-chain was taken. */
  done: boolean
  parentActive: boolean
  elseSeen: boolean
  line: number
}

export function preprocess(project: Project, mainFile: string): PPResult {
  const pp = new Preprocessor(project)
  return pp.run(mainFile)
}

class Preprocessor {
  macros = new Map<string, Macro>()
  out: OutLine[] = []
  steps: PPStep[] = []
  errors: Diagnostic[] = []
  once = new Set<string>()
  includes: string[] = []
  expansions = 0
  noted = new WeakSet<PPToken>()

  constructor(private project: Project) {}

  run(mainFile: string): PPResult {
    const file = this.project.files.find((f) => f.name === mainFile)
    const text = file?.text ?? ''
    const p1 = pass1(mainFile, text)
    const p2 = pass2(mainFile, p1.lines)
    this.errors.push(...p1.errors, ...p2.errors)
    this.processLines(mainFile, p2.lines, 0)
    const tokens = this.out.flatMap((l) => l.tokens)
    return { lines: this.out, tokens, steps: this.steps, errors: this.errors, pass1: p1, pass2: p2.lines, macros: this.macros, includes: this.includes }
  }

  private step(s: Omit<PPStep, 'outCount'> & Record<string, unknown>) {
    this.steps.push({ ...s, outCount: this.out.length } as PPStep)
  }

  private error(code: string, file: string, line: number, params?: Record<string, string | number>) {
    this.errors.push({ stage: 'pp', code, file, line, params })
  }

  private emit(file: string, line: number, depth: number, kind: OutLine['kind'], tokens: PPToken[] = [], expanded = false) {
    this.out.push({ tokens, text: tokensText(tokens), file, line, depth, kind, expanded })
  }

  private processFile(name: string, text: string, depth: number) {
    const p1 = pass1(name, text)
    const p2 = pass2(name, p1.lines)
    this.errors.push(...p1.errors, ...p2.errors)
    this.processLines(name, p2.lines, depth)
  }

  private processLines(file: string, lines: PPToken[][], depth: number) {
    const conds: Cond[] = []
    const active = () => conds.every((c) => c.active)
    let i = 0
    while (i < lines.length) {
      const toks = lines[i]
      const lineNo = i + 1
      if (toks.length && canonical(toks[0].text) === '#') {
        try {
          this.directive(file, lineNo, toks, conds, active(), depth)
        } catch (e) {
          if (e instanceof DiagnosticError) this.errors.push(e.diag)
          else throw e
        }
        i++
        continue
      }
      if (!active()) {
        this.emit(file, lineNo, depth, 'skipped')
        i++
        continue
      }
      // A function-like macro call may continue on the next lines.
      let next = i + 1
      const pull = (): PPToken[] | null => {
        while (next < lines.length) {
          const l = lines[next]
          if (l.length && canonical(l[0].text) === '#') return null
          next++
          if (l.length) return l
        }
        return null
      }
      const before = this.steps.length
      let result: PPToken[]
      try {
        result = this.expand(toks.map((t) => ({ ...t })), file, lineNo, pull)
      } catch (e) {
        if (!(e instanceof DiagnosticError)) throw e
        this.errors.push(e.diag)
        result = toks
      }
      const expanded = this.steps.slice(before).some((s) => s.kind === 'expand')
      this.emit(file, lineNo, depth, 'text', result, expanded)
      // keep line numbers: lines pulled into a macro call become blank
      for (let k = i + 1; k < next; k++) this.emit(file, k + 1, depth, 'text')
      i = next
    }
    for (const c of conds) this.error('unterminatedIf', file, c.line)
  }

  // ------------------------------------------------------------------ directives

  private directive(file: string, line: number, toks: PPToken[], conds: Cond[], active: boolean, depth: number) {
    const name = toks[1]?.text ?? ''
    const args = toks.slice(2)
    const emitDirective = () => this.emit(file, line, depth, 'directive')
    const cond = (directive: 'if' | 'ifdef' | 'ifndef', taken: boolean, expr?: string, value?: string) => {
      conds.push({ active: active && taken, done: taken, parentActive: active, elseSeen: false, line })
      emitDirective()
      if (active) this.step({ kind: 'cond', directive, expr, value, taken, file, line })
    }

    switch (name) {
      case 'ifdef':
      case 'ifndef': {
        if (!active) return cond(name, false)
        const id = args[0]
        if (!id || id.kind !== 'ident') throw this.diag('expectedMacroName', file, line, { directive: name })
        const def = this.macros.has(id.text)
        return cond(name, name === 'ifdef' ? def : !def, id.text)
      }
      case 'if': {
        if (!active) return cond('if', false)
        const v = this.ifValue(file, line, args)
        return cond('if', v !== 0n, tokensText(args), v.toString())
      }
      case 'elif': {
        const c = conds.at(-1)
        if (!c) throw this.diag('elifWithoutIf', file, line)
        if (c.elseSeen) throw this.diag('elifAfterElse', file, line)
        emitDirective()
        if (!c.parentActive || c.done) {
          c.active = false
          if (c.parentActive) this.step({ kind: 'cond', directive: 'elif', expr: tokensText(args), taken: false, file, line })
          return
        }
        const v = this.ifValue(file, line, args)
        c.active = v !== 0n
        c.done = c.active
        this.step({ kind: 'cond', directive: 'elif', expr: tokensText(args), value: v.toString(), taken: c.active, file, line })
        return
      }
      case 'else': {
        const c = conds.at(-1)
        if (!c) throw this.diag('elseWithoutIf', file, line)
        if (c.elseSeen) throw this.diag('elseAfterElse', file, line)
        c.elseSeen = true
        c.active = c.parentActive && !c.done
        c.done = true
        emitDirective()
        if (c.parentActive) this.step({ kind: 'cond', directive: 'else', taken: c.active, file, line })
        return
      }
      case 'endif': {
        const c = conds.pop()
        if (!c) throw this.diag('endifWithoutIf', file, line)
        emitDirective()
        if (c.parentActive) this.step({ kind: 'cond', directive: 'endif', taken: true, file, line })
        return
      }
    }

    if (!active) {
      emitDirective()
      return
    }

    switch (name) {
      case '':
        emitDirective() // the null directive: a lone '#'
        return
      case 'define':
        emitDirective()
        return this.define(file, line, args)
      case 'undef': {
        emitDirective()
        const id = args[0]
        if (!id || id.kind !== 'ident') throw this.diag('expectedMacroName', file, line, { directive: 'undef' })
        const existed = this.macros.delete(id.text)
        this.step({ kind: 'undef', name: id.text, existed, file, line })
        return
      }
      case 'include':
        return this.include(file, line, args, depth)
      case 'error':
        emitDirective()
        throw this.diag('errorDirective', file, line, { text: tokensText(args) })
      case 'warning':
      case 'pragma': {
        emitDirective()
        if (name === 'pragma' && args[0]?.text === 'once') this.once.add(file)
        this.step({ kind: 'pragma', text: `#${name} ${tokensText(args)}`.trim(), file, line })
        return
      }
      default:
        emitDirective()
        throw this.diag('unknownDirective', file, line, { name: '#' + name })
    }
  }

  private diag(code: string, file: string, line: number, params?: Record<string, string | number>) {
    return new DiagnosticError({ stage: 'pp', code, file, line, params })
  }

  private ifValue(file: string, line: number, args: PPToken[]): bigint {
    // 1. `defined X` / `defined(X)` → 1 or 0 (before macro replacement)
    const toks: PPToken[] = []
    for (let i = 0; i < args.length; i++) {
      const t = args[i]
      if (t.kind === 'ident' && t.text === 'defined') {
        let j = i + 1
        const paren = args[j]?.text === '('
        if (paren) j++
        const id = args[j]
        if (!id || id.kind !== 'ident') throw this.diag('definedSyntax', file, line)
        if (paren && args[j + 1]?.text !== ')') throw this.diag('definedSyntax', file, line)
        toks.push({ ...t, kind: 'number', text: this.macros.has(id.text) ? '1' : '0' })
        i = paren ? j + 1 : j
        continue
      }
      toks.push({ ...t })
    }
    // 2. replace macros (not recorded as steps), 3. evaluate
    const expanded = this.expand(toks, file, line, () => null, false)
    if (!expanded.length) throw this.diag('ifEmpty', file, line)
    return evalIfExpr(expanded)
  }

  private define(file: string, line: number, args: PPToken[]) {
    const id = args[0]
    if (!id || id.kind !== 'ident') throw this.diag('expectedMacroName', file, line, { directive: 'define' })
    if (id.text === 'defined') throw this.diag('defineDefined', file, line)
    let params: string[] | undefined
    let k = 1
    // function-like only if '(' follows the name immediately (no space)
    if (args[1]?.text === '(' && !args[1].space) {
      params = []
      k = 2
      if (args[k]?.text === ')') k++
      else {
        for (;;) {
          const p = args[k]
          if (p?.text === '...') throw this.diag('variadicMacro', file, line)
          if (!p || p.kind !== 'ident') throw this.diag('badMacroParams', file, line)
          if (params.includes(p.text)) throw this.diag('duplicateParam', file, line, { name: p.text })
          params.push(p.text)
          k++
          if (args[k]?.text === ',') k++
          else if (args[k]?.text === ')') {
            k++
            break
          } else throw this.diag('badMacroParams', file, line)
        }
      }
    }
    const body = args.slice(k).map((t, i) => ({ ...t, space: i === 0 ? false : t.space }))
    if (body.length && canonical(body[0].text) === '##') throw this.diag('pasteAtEdge', file, line)
    if (body.length && canonical(body[body.length - 1].text) === '##') throw this.diag('pasteAtEdge', file, line)
    if (params) {
      body.forEach((t, i) => {
        if (canonical(t.text) === '#' && !(body[i + 1]?.kind === 'ident' && params!.includes(body[i + 1].text)))
          throw this.diag('hashNotParam', file, line)
      })
    }
    const macro: Macro = { name: id.text, params, body, file, line }
    const redefined = this.macros.has(id.text)
    this.macros.set(id.text, macro)
    this.step({ kind: 'define', macro, redefined, file, line })
  }

  private include(file: string, line: number, args: PPToken[], depth: number) {
    const t = args[0]
    let target: string
    let system: boolean
    if (t?.kind === 'header') {
      target = t.text.slice(1, -1)
      system = true
    } else if (t?.kind === 'string' && t.text.startsWith('"')) {
      target = t.text.slice(1, -1)
      system = false
    } else throw this.diag('includeSyntax', file, line)
    if (args.length > 1) throw this.diag('includeSyntax', file, line)
    if (depth >= MAX_INCLUDE_DEPTH) throw this.diag('includeDepth', file, line, { name: target })

    // "..." looks in the project first, then the system headers; <...> only in the system headers.
    let text: string | undefined
    let resolved = target
    const own = !system ? this.project.files.find((f) => f.name === target) : undefined
    if (own) text = own.text
    else if (target in SYSTEM_HEADERS) {
      text = SYSTEM_HEADERS[target]
      resolved = `<${target}>`
    }
    if (text === undefined) {
      this.emit(file, line, depth, 'directive')
      throw this.diag(system ? 'systemHeaderNotFound' : 'includeNotFound', file, line, { name: target })
    }
    if (this.once.has(resolved)) {
      this.emit(file, line, depth, 'directive')
      this.step({ kind: 'include', target, system, resolved, skipped: 'once', file, line })
      return
    }
    if (!this.includes.includes(resolved)) this.includes.push(resolved)
    this.step({ kind: 'include', target, system, resolved, file, line })
    this.processFile(resolved, text, depth + 1)
    this.step({ kind: 'includeEnd', target: resolved, file, line })
  }

  // ------------------------------------------------------------------ macro replacement

  /** Replace all macros in `toks`; `pull` supplies following lines for multi-line calls. */
  expand(toks: PPToken[], file: string, line: number, pull: () => PPToken[] | null, record = true): PPToken[] {
    const buf = toks
    this.expandRange(buf, 0, buf.length, pull, record, false, file, line)
    return buf.filter((t) => t.kind !== 'other' || t.text !== '')
  }

  /**
   * Replace macros in buf[lo, hi). Returns the new end of the range. Expansion results are
   * rescanned (together with the rest of the range) until nothing can be replaced.
   */
  private expandRange(
    buf: PPToken[], lo: number, hi: number, pull: (() => PPToken[] | null) | null,
    record: boolean, inArg: boolean, file: string, line: number,
  ): number {
    let i = lo
    while (i < hi) {
      const t = buf[i]
      if (t.kind === 'number') {
        if (record) this.notePPNumber(t, file, line)
        i++
        continue
      }
      if (t.kind !== 'ident' || t.painted) {
        i++
        continue
      }
      const m = this.macros.get(t.text)
      if (!m) {
        if (t.text === '__LINE__' || t.text === '__FILE__') {
          const v = t.text === '__LINE__' ? String(t.line) : JSON.stringify(t.file)
          buf[i] = { ...t, kind: t.text === '__LINE__' ? 'number' : 'string', text: v }
        }
        i++
        continue
      }
      if (t.hide?.has(t.text)) {
        // A macro inside its own expansion: blocked for good ("painted blue").
        t.painted = true
        if (record) this.step({ kind: 'blocked', macro: t.text, tokens: buf.map((x) => ({ ...x })), index: i, file, line })
        i++
        continue
      }
      if (++this.expansions > MAX_EXPANSIONS) throw this.diag('expansionLimit', file, line)

      if (!m.params) {
        const hide = new Set(t.hide ?? [])
        hide.add(m.name)
        const repl = this.substitute(m, [], [], t, hide, file, line)
        const before = record ? buf.map((x) => ({ ...x })) : []
        buf.splice(i, 1, ...repl)
        hi += repl.length - 1
        if (record) this.recordExpand(m, before, buf, [i, i + 1], [i, i + repl.length], undefined, inArg, file, line)
        continue // rescan the replacement
      }

      // function-like: only a call if '(' follows (possibly on the next line)
      let j = i + 1
      while (j >= hi && pull && hi === buf.length) {
        const more = pull()
        if (!more) break
        const copy = more.map((x) => ({ ...x }))
        if (copy.length) copy[0].space = true
        buf.push(...copy)
        hi = buf.length
      }
      if (j >= hi || canonical(buf[j].text) !== '(') {
        i++
        continue
      }
      // collect arguments
      const argRanges: [number, number][] = []
      let depthP = 0
      let start = j + 1
      let k = j + 1
      for (;;) {
        while (k >= hi && pull && hi === buf.length) {
          const more = pull()
          if (!more) break
          const copy = more.map((x) => ({ ...x }))
          if (copy.length) copy[0].space = true
          buf.push(...copy)
          hi = buf.length
        }
        if (k >= hi) throw this.diag('unterminatedCall', file, line, { name: m.name })
        const s = canonical(buf[k].text)
        if (s === '(') depthP++
        else if (s === ')') {
          if (depthP === 0) break
          depthP--
        } else if (s === ',' && depthP === 0) {
          argRanges.push([start, k])
          start = k + 1
        }
        k++
      }
      argRanges.push([start, k])
      if (m.params.length === 0 && argRanges.length === 1 && argRanges[0][0] === argRanges[0][1]) argRanges.length = 0
      if (argRanges.length !== m.params.length)
        throw this.diag('macroArgCount', file, line, { name: m.name, expected: m.params.length, got: argRanges.length })

      const raw = argRanges.map(([a, b]) => buf.slice(a, b).map((x) => ({ ...x })))
      // Arguments are fully macro-replaced before they are substituted (unless used with # or ##).
      // This happens in place, so each replacement inside an argument is its own visible step.
      let shift = 0
      const expandedArgs: PPToken[][] = []
      for (let a = 0; a < argRanges.length; a++) {
        const [s0, e0] = [argRanges[a][0] + shift, argRanges[a][1] + shift]
        if (this.usedPlain(m, m.params[a])) {
          const e1 = this.expandRange(buf, s0, e0, null, record, true, file, line)
          shift += e1 - e0
          expandedArgs.push(buf.slice(s0, e1).map((x) => ({ ...x })))
        } else expandedArgs.push(raw[a])
      }
      k += shift
      hi += shift
      const rparen = buf[k]
      const hide = new Set([...(t.hide ?? [])].filter((h) => rparen.hide?.has(h)))
      hide.add(m.name)
      const repl = this.substitute(m, raw, expandedArgs, t, hide, file, line)
      const before = record ? buf.map((x) => ({ ...x })) : []
      buf.splice(i, k - i + 1, ...repl)
      hi += repl.length - (k - i + 1)
      if (record) this.recordExpand(m, before, buf, [i, k + 1], [i, i + repl.length], raw.map(tokensText), inArg, file, line)
    }
    return hi
  }

  private recordExpand(m: Macro, before: PPToken[], after: PPToken[], from: [number, number], to: [number, number], args: string[] | undefined, inArg: boolean, file: string, line: number) {
    this.step({
      kind: 'expand', macro: m.name, functionLike: !!m.params, before, after: after.map((x) => ({ ...x })),
      from, to, args, inArg: inArg || undefined, file, line,
    })
  }

  /** Is parameter `p` used in the body without `#` / `##` next to it? */
  private usedPlain(m: Macro, p: string): boolean {
    return m.body.some((t, i) => {
      if (t.kind !== 'ident' || t.text !== p) return false
      const prev = m.body[i - 1] && canonical(m.body[i - 1].text)
      const next = m.body[i + 1] && canonical(m.body[i + 1].text)
      return prev !== '#' && prev !== '##' && next !== '##'
    })
  }

  /** Build the replacement list: parameters substituted, `#` stringified, `##` pasted. */
  private substitute(m: Macro, raw: PPToken[][], expanded: PPToken[][], site: PPToken, hide: Set<string>, file: string, line: number): PPToken[] {
    const params = m.params ?? []
    const at = (t: PPToken, space: boolean): PPToken => ({
      ...t, file: site.file, line: site.line, col: site.col, space, hide: new Set([...(t.hide ?? []), ...hide]), fromMacro: m.name, painted: t.painted,
    })
    const PLACEMARKER = '\u0000'
    const out: PPToken[] = []
    const pasteOps = new WeakSet<PPToken>()
    const body = m.body
    for (let i = 0; i < body.length; i++) {
      const t = body[i]
      const s = canonical(t.text)
      if (m.params && s === '#') {
        const p = params.indexOf(body[i + 1].text)
        out.push(at({ ...t, kind: 'string', text: stringify(raw[p]) }, t.space))
        i++
        continue
      }
      const pi = t.kind === 'ident' ? params.indexOf(t.text) : -1
      if (pi >= 0) {
        const nextPaste = body[i + 1] && canonical(body[i + 1].text) === '##'
        const prevPaste = body[i - 1] && canonical(body[i - 1].text) === '##'
        const src = nextPaste || prevPaste ? raw[pi] : expanded[pi]
        if (!src.length) out.push(at({ ...t, kind: 'other', text: PLACEMARKER }, t.space))
        else src.forEach((x, k) => out.push(at(x, k === 0 ? t.space : x.space)))
        continue
      }
      const tok = at(t, t.space)
      if (s === '##') pasteOps.add(tok)
      out.push(tok)
    }
    // ## : paste the tokens left and right of it into one token
    for (let i = 0; i < out.length; i++) {
      if (!pasteOps.has(out[i])) continue
      const a = out[i - 1]
      const b = out[i + 1]
      const text = (a.text === PLACEMARKER ? '' : a.text) + (b.text === PLACEMARKER ? '' : b.text)
      let tok: PPToken
      if (text === '') tok = { ...a, kind: 'other', text: PLACEMARKER }
      else {
        const r = tokenizeLine(site.file, site.line, text)
        if (r.tokens.length !== 1 || r.errors.length) throw this.diag('badPaste', file, line, { a: a.text, b: b.text })
        tok = { ...a, kind: r.tokens[0].kind, text }
      }
      out.splice(i - 1, 3, tok)
      i--
    }
    const res = out.filter((t) => t.text !== PLACEMARKER)
    if (res.length) res[0] = { ...res[0], space: site.space }
    return res
  }

  /** A pp-number like `123.X` may contain a macro name, which is not replaced: it is not an identifier. */
  private notePPNumber(t: PPToken, file: string, line: number) {
    if (this.noted.has(t)) return
    this.noted.add(t)
    // skip the 0x / 0b prefix of hex and binary numbers
    const body = /^0[xXbB]/.test(t.text) ? t.text.slice(2) : t.text
    for (const w of body.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      if (this.macros.has(w)) {
        this.step({ kind: 'ppnumber', token: t.text, name: w, file, line })
        return
      }
    }
  }
}

/** The `#` operator: the argument's spelling as a string literal. */
function stringify(toks: PPToken[]): string {
  const s = toks
    .map((t, i) => {
      const txt = t.kind === 'string' || t.kind === 'char' ? t.text.replace(/[\\"]/g, (c) => '\\' + c) : t.text
      return (i > 0 && t.space ? ' ' : '') + txt
    })
    .join('')
  return `"${s}"`
}
