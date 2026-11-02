import { ArrowDown } from 'lucide-react'
import { useMemo } from 'react'
import { t } from '../../../i18n'
import { tokensText, type PPStep, type PPToken } from '../../../toolchain/pp'
import { Panel } from '../../cpu/components/Panel'
import { CodeView, type Mark } from '../components/CodeView'
import { ErrorList, Explain, FileTabs, P } from '../components/common'
import { activeText } from '../components/util'
import { currentIndex, pass2Lines, unitOf } from '../steps'
import { useToolchain, type Pass } from '../store'

export function PreprocessorStage() {
  const T = t().tc.pp
  const st = useToolchain()
  const u = unitOf(st.build, st.unit)
  const active = activeText(st.files, st.activeFile)
  const pass = st.pass

  return (
    <>
      <div className="tc-stage">
        <Panel title={T.input} area="in" className="tc-in">
          <FileTabs />
          <InputView pass={pass} text={active.text} readOnly={active.readOnly} />
        </Panel>
        <Panel
          title={T.output(pass)}
          area="out"
          className="tc-out"
          actions={
            <div className="segmented" role="radiogroup" aria-label={T.output(pass)}>
              {([1, 2, 3] as Pass[]).map((p) => (
                <button key={p} type="button" role="radio" aria-checked={pass === p} className={pass === p ? 'is-active' : ''} onClick={() => st.setPass(p)}>
                  {T.passes[p]}
                </button>
              ))}
            </div>
          }
        >
          {u ? pass === 1 ? <Pass1View /> : pass === 2 ? <Pass2View /> : <Pass3View /> : <p className="empty">{t().tc.errors.noSourceFiles({})}</p>}
          <ErrorList errors={u?.pp.errors ?? st.build.errors} />
        </Panel>
      </div>
      <PPExplain />
    </>
  )
}

/** The source editor; it marks what the current step is about. */
function InputView({ pass, text, readOnly }: { pass: Pass; text: string; readOnly: boolean }) {
  const st = useToolchain()
  const u = unitOf(st.build, st.unit)
  const isUnit = st.activeFile === u?.file
  const { lines, scroll } = useMemo(() => {
    const lines = new Map<number, string>()
    let scroll: number | null = null
    if (!u) return { lines, scroll }
    if (pass === 1 && isUnit) {
      const ch = u.pp.pass1.changes
      const cur = currentIndex(st.pos, ch.length)
      ch.forEach((c, i) => {
        for (let l = c.line; l <= c.endLine; l++) lines.set(l, (c.kind === 'splice' ? 'tc-joined' : 'tc-removed') + (i === cur ? ' tc-current' : ''))
      })
      if (cur >= 0) scroll = ch[cur].line
    } else if (pass === 2 && isUnit) {
      const pl = pass2Lines(u)
      const cur = currentIndex(st.pos, pl.length)
      if (st.pos !== null && cur >= 0) {
        lines.set(pl[cur], 'tc-current')
        scroll = pl[cur]
      }
    } else if (pass === 3) {
      const steps = u.pp.steps
      const cur = currentIndex(st.pos, steps.length)
      const s = st.pos !== null ? steps[cur] : undefined
      if (s && s.file === st.activeFile) {
        lines.set(s.line, 'tc-current')
        scroll = s.line
      }
    }
    return { lines, scroll }
  }, [u, pass, st.pos, isUnit, st.activeFile])
  return (
    <CodeView
      doc={text}
      language="c"
      editable={!readOnly}
      onChange={(txt) => st.setText(st.activeFile, txt)}
      lineClasses={lines}
      scrollTo={scroll}
      label={t().tc.pp.input}
    />
  )
}

function Pass1View() {
  const st = useToolchain()
  const u = unitOf(st.build, st.unit)!
  const p1 = u.pp.pass1
  const cur = currentIndex(st.pos, p1.changes.length)
  const lines = useMemo(() => {
    const m = new Map<number, string>()
    p1.changes.forEach((c, i) => m.set(c.line, (c.kind === 'splice' ? 'tc-joined' : 'tc-changed') + (i === cur ? ' tc-current' : '')))
    return m
  }, [p1, cur])
  return <CodeView doc={p1.lines.join('\n')} language="c" lineClasses={lines} scrollTo={cur >= 0 ? p1.changes[cur].line : null} label={t().tc.pp.output(1)} />
}

function Pass2View() {
  const T = t().tc.pp
  const st = useToolchain()
  const u = unitOf(st.build, st.unit)!
  const pl = pass2Lines(u)
  const shown = st.pos === null ? Infinity : st.pos
  const cur = st.pos === null ? -1 : pl[st.pos - 1]
  const kinds = ['ident', 'number', 'string', 'char', 'punct', 'header']
  return (
    <div className="tokens-view">
      <div className="token-legend" aria-label={T.legend}>
        {kinds.map((k) => (
          <span key={k} className={`tok tok-${k}`}>
            {T.tokenKinds[k]}
          </span>
        ))}
      </div>
      <ol className="token-lines">
        {u.pp.pass2.map((toks, i) => {
          const line = i + 1
          if (!toks.length) return null
          const idx = pl.indexOf(line)
          const visible = idx < shown
          return (
            <li key={i} className={'token-line' + (line === cur ? ' is-current' : '') + (visible ? '' : ' is-pending')} ref={line === cur ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
              <span className="ln mono">{line}</span>
              <span className="chips">
                {visible &&
                  toks.map((tk, k) => (
                    <span key={k} className={`tok tok-${tk.kind}`} title={T.tokenKinds[tk.kind]}>
                      {tk.text}
                    </span>
                  ))}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const BAND_COUNT = 6

/** Keep the source indentation of a line (like clang -E does). */
function indent(l: { tokens: PPToken[]; text: string }): string {
  const first = l.tokens[0]
  return first && !first.fromMacro ? ' '.repeat(Math.max(0, first.col - 1)) + l.text : l.text
}

function Pass3View() {
  const T = t().tc.pp
  const st = useToolchain()
  const u = unitOf(st.build, st.unit)!
  const steps = u.pp.steps
  const cur = currentIndex(st.pos, steps.length)
  const step = st.pos !== null && cur >= 0 ? steps[cur] : undefined
  const count = st.pos === null ? u.pp.lines.length : step ? step.outCount : 0
  const inLine = !!step && (step.kind === 'expand' || step.kind === 'blocked' || step.kind === 'ppnumber')
  const files = useMemo(() => [...new Set(u.pp.lines.filter((l) => l.depth > 0).map((l) => l.file))], [u])
  const { doc, classes, gutter, titles } = useMemo(() => {
    const shown = u.pp.lines.slice(0, Math.max(count, 0))
    const classes = new Map<number, string>()
    const gutter = new Map<number, string>()
    const titles = new Map<number, string>()
    shown.forEach((l, i) => {
      const c: string[] = []
      if (l.depth > 0) c.push(`tc-band tc-band-${files.indexOf(l.file) % BAND_COUNT}`)
      if (l.kind !== 'text') c.push('tc-gone')
      if (l.expanded) c.push('tc-expanded')
      if (i === count - 1 && step && !inLine) c.push('tc-current')
      classes.set(i + 1, c.join(' '))
      gutter.set(i + 1, `${l.file.replace(/^<|>$/g, '')}:${l.line}`)
      titles.set(i + 1, T.fromFile(l.file))
    })
    const texts = shown.map((l) => indent(l))
    // a replacement inside a line: show the line being rewritten (it is emitted when it is finished)
    if (inLine && step) {
      const toks = step.kind === 'expand' ? step.after : step.kind === 'blocked' ? step.tokens : null
      const src = u.pp.pass2[step.line - 1] ?? []
      texts.push(toks ? tokensText(toks) : src.map((x) => x.text).join(' '))
      const n = texts.length
      classes.set(n, 'tc-current' + (step.kind === 'expand' ? ' tc-expanded' : ''))
      gutter.set(n, `${step.file.replace(/^<|>$/g, '')}:${step.line}`)
    }
    return { doc: texts.join('\n'), classes, gutter, titles }
  }, [u, count, files, step, T, inLine])
  return (
    <div className="pass3">
      {step && (step.kind === 'expand' || step.kind === 'blocked') && <ExpansionCard step={step} />}
      <CodeView doc={doc} language="c" lineClasses={classes} gutterText={gutter} gutterTitle={titles} showLineNumbers={false} scrollTo={count + (inLine ? 1 : 0)} label={T.output(3)} />
      <div className="band-legend">
        {files.map((f, i) =>
          f === u.file ? null : (
            <span key={f} className={`band-key tc-band-${i % BAND_COUNT}`}>
              {f}
            </span>
          ),
        )}
        <span className="panel-hint">{T.diffLegend}</span>
      </div>
    </div>
  )
}

function TokenRow({ toks, from, to, cls }: { toks: PPToken[]; from: number; to: number; cls: string }) {
  return (
    <div className="exp-row mono">
      {toks.map((tk, i) => (
        <span key={i} className={'exp-tok' + (i >= from && i < to ? ' ' + cls : '') + (tk.painted ? ' is-painted' : '')}>
          {tk.text}
        </span>
      ))}
    </div>
  )
}

function ExpansionCard({ step }: { step: Extract<PPStep, { kind: 'expand' | 'blocked' }> }) {
  if (step.kind === 'blocked') {
    return (
      <div className="exp-card is-blocked" role="status">
        <TokenRow toks={step.tokens} from={step.index} to={step.index + 1} cls="is-blocked" />
      </div>
    )
  }
  return (
    <div className="exp-card" role="status" key={`${step.line}-${step.macro}-${step.from[0]}`}>
      <TokenRow toks={step.before} from={step.from[0]} to={step.from[1]} cls="is-from" />
      <ArrowDown size={14} className="exp-arrow" aria-hidden />
      <TokenRow toks={step.after} from={step.to[0]} to={step.to[1]} cls="is-to" />
    </div>
  )
}

function stepText(s: PPStep): string {
  const S = t().tc.pp.step
  switch (s.kind) {
    case 'define': return S.define(s.macro.name + (s.macro.params ? `(${s.macro.params.join(', ')})` : ''), !!s.macro.params, tokensText(s.macro.body), s.redefined)
    case 'undef': return S.undef(s.name, s.existed)
    case 'cond': return S.cond(s.directive, s.expr, s.value, s.taken)
    case 'include': return s.skipped ? S.includeOnce(s.target) : S.include(s.target, s.system, s.resolved)
    case 'includeEnd': return S.includeEnd(s.target)
    case 'expand': return S.expand(s.macro, s.functionLike, s.args, !!s.inArg)
    case 'blocked': return S.blocked(s.macro)
    case 'ppnumber': return S.ppnumber(s.token, s.name)
    case 'pragma': return S.pragma(s.text)
  }
}

function PPExplain() {
  const T = t().tc.pp
  const st = useToolchain()
  const u = unitOf(st.build, st.unit)
  const texts: string[] = []
  if (u) {
    if (st.pass === 1) {
      const ch = u.pp.pass1.changes
      const cur = currentIndex(st.pos, ch.length)
      texts.push(T.pass1Intro)
      if (!ch.length) texts.push(T.pass1None)
      else if (st.pos !== null && cur >= 0) {
        const c = ch[cur]
        texts.push(c.kind === 'splice' ? T.pass1Splice(c.line, c.endLine) : T.pass1Comment(c.kind, c.line, c.endLine))
      }
    } else if (st.pass === 2) {
      texts.push(T.pass2Intro)
      const pl = pass2Lines(u)
      const line = st.pos !== null && st.pos > 0 ? pl[st.pos - 1] : undefined
      if (line) {
        const toks = u.pp.pass2[line - 1]
        texts.push(T.pass2Line(line, toks.length))
        if (toks.some((x) => x.kind === 'number' && /[^0-9a-fA-FxXuUlL]/.test(x.text))) texts.push(T.pass2Number)
        const greedy = toks.filter((x, i) => x.kind === 'punct' && (x.text === '++' || x.text === '--') && toks[i + 1]?.kind === 'punct' && /^[+-]/.test(toks[i + 1].text))
        if (greedy.length) texts.push(T.pass2Greedy(toks.map((x) => x.text).join(' ')))
      } else if (u.pp.pass2.flat().some((x) => x.kind === 'number' && /[.+-]|[g-wyzG-WYZ]/.test(x.text))) texts.push(T.pass2Number)
    } else {
      texts.push(T.pass3Intro)
      const cur = currentIndex(st.pos, u.pp.steps.length)
      if (st.pos !== null && cur >= 0) texts.push(stepText(u.pp.steps[cur]))
    }
  }
  return (
    <Explain>
      {texts.map((x, i) => (
        <P key={i} text={x} className={i === 0 && texts.length > 1 ? 'muted' : 'summary'} />
      ))}
    </Explain>
  )
}

export type { Mark }
