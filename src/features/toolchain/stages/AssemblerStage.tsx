import { useMemo } from 'react'
import { t } from '../../../i18n'
import type { SectionName } from '../../../core/assembler'
import { relocTargetText, type ObjectFile } from '../../../core/object'
import { Panel } from '../../cpu/components/Panel'
import { CodeView } from '../components/CodeView'
import { ErrorList, Explain, P } from '../components/common'
import { asmByteLines, currentIndex, unitOf } from '../steps'
import { useToolchain } from '../store'

const hex = (n: number, w = 4) => n.toString(16).padStart(w, '0')
const hb = (b: number) => b.toString(16).padStart(2, '0')

interface ByteRow {
  line: number
  section: SectionName
  offset: number
  bytes: number[]
  /** true for bytes that are relocation placeholders */
  unknown: boolean[]
  text: string
  relocs: number[]
}

function rows(o: ObjectFile, lines: number[], src: string[]): ByteRow[] {
  return lines.map((line) => {
    const ins = o.instructions.find((i) => i.line === line)
    const loc = o.lineToOffset.get(line)!
    let bytes: number[]
    let section: SectionName
    if (ins) {
      bytes = ins.bytes
      section = 'text'
    } else {
      const d = o.dataItems.find((x) => x.line === line)!
      section = loc.section
      bytes = section === 'bss' ? new Array(Math.min(d.size, 16)).fill(0) : Array.from(o.sections[section].bytes.subarray(d.address, d.address + d.size))
    }
    const offset = loc.offset
    const unknown = bytes.map(() => false)
    const relocs: number[] = []
    o.relocations.forEach((r, ri) => {
      if (r.section !== section || r.offset < offset || r.offset >= offset + bytes.length) return
      relocs.push(ri)
      for (let k = 0; k < r.size; k++) unknown[r.offset - offset + k] = true
    })
    return { line, section, offset, bytes, unknown, text: (src[line - 1] ?? '').replace(/;.*/, '').trim(), relocs }
  })
}

export function AssemblerStage() {
  const T = t().tc.as
  const st = useToolchain()
  const u = unitOf(st.build, st.unit)
  const o = u?.obj ?? null
  const asmText = u?.cc?.asm ?? ''
  const lines = useMemo(() => asmByteLines(u), [u])
  const data = useMemo(() => (o ? rows(o, lines, asmText.split('\n')) : []), [o, lines, asmText])
  const shown = st.pos === null ? data.length : st.pos
  const cur = st.pos !== null ? currentIndex(st.pos, data.length) : -1
  const focus = st.pinned ?? st.hover
  const focusLine = focus?.kind === 'asm' ? focus.line : cur >= 0 ? data[cur].line : null

  const { classes, gutter } = useMemo(() => {
    const classes = new Map<number, string>()
    const gutter = new Map<number, string>()
    data.forEach((r, i) => {
      if (i < shown) gutter.set(r.line, `${r.section === 'text' ? 't' : r.section === 'data' ? 'd' : 'b'} ${hex(r.offset)}`)
      const c = [r.relocs.length ? 'tc-has-reloc' : 'tc-has-bytes']
      if (r.line === focusLine) c.push('tc-current')
      classes.set(r.line, c.join(' '))
    })
    return { classes, gutter }
  }, [data, shown, focusLine])

  return (
    <>
      <div className="tc-stage">
        <Panel title={`${T.input} · ${u?.asmName ?? ''}`} area="in" className="tc-in">
          {u?.cc && !u.cc.errors.length ? (
            <CodeView
              doc={asmText}
              language="nasm"
              lineClasses={classes}
              gutterText={gutter}
              onHoverLine={(line) => st.setHover(line ? { kind: 'asm', line } : null)}
              onClickLine={(line) => st.setPinned({ kind: 'asm', line })}
              scrollTo={cur >= 0 ? data[cur].line : null}
              label={T.input}
            />
          ) : (
            <p className="empty">{t().tc.notReached(t().tc.stages.as)}</p>
          )}
        </Panel>
        <Panel title={`${T.output} · ${u?.objName ?? ''}`} area="out" className="tc-out">
          {o ? (
            <div className="obj-view">
              <section className="obj-block obj-bytes" aria-label={T.bytes}>
                <h3>{T.bytes}</h3>
                <ol className="byte-rows mono">
                  {data.map((r, i) =>
                    i < shown ? (
                      <li
                        key={r.line}
                        className={'byte-row' + (r.line === focusLine ? ' is-current' : '')}
                        onMouseEnter={() => st.setHover({ kind: 'asm', line: r.line })}
                        onMouseLeave={() => st.setHover(null)}
                        ref={i === cur ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                      >
                        <span className="br-off">
                          .{r.section} {hex(r.offset)}
                        </span>
                        <span className="br-bytes">
                          {r.bytes.slice(0, 16).map((b, k) =>
                            r.unknown[k] ? (
                              <span key={k} className="byte-unknown" title={T.placeholder}>
                                ??
                              </span>
                            ) : (
                              <span key={k}>{hb(b)}</span>
                            ),
                          )}
                          {r.bytes.length > 16 && <span className="muted">…</span>}
                        </span>
                        <span className="br-src">{r.text}</span>
                      </li>
                    ) : null,
                  )}
                </ol>
              </section>
              <section className="obj-block" aria-label={T.symbols}>
                <h3>{T.symbols}</h3>
                <SymbolTable o={o} />
              </section>
              <section className="obj-block" aria-label={T.relocs}>
                <h3>{T.relocs}</h3>
                {o.relocations.length ? (
                  <table className="tc-table mono">
                    <thead>
                      <tr>
                        {T.relocCols.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {o.relocations.map((r, i) => (
                        <tr key={i} className={data[cur]?.relocs.includes(i) ? 'is-current' : ''} onMouseEnter={() => st.setHover({ kind: 'asm', line: r.line })} onMouseLeave={() => st.setHover(null)}>
                          <td>
                            .{r.section} {hex(r.offset)}
                          </td>
                          <td title={T.relocTypes[r.type]}>{r.type}</td>
                          <td>{relocTargetText(r.target, r.addend)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted">{T.noRelocs}</p>
                )}
              </section>
            </div>
          ) : null}
          <ErrorList errors={st.build.stoppedAt === 'as' ? st.build.errors : []} />
        </Panel>
      </div>
      <Explain>
        <P className="muted" text={T.intro} />
        {cur >= 0 && <P className="summary" text={rowText(data[cur], o!)} />}
        {cur < 0 && focusLine && data.find((r) => r.line === focusLine) && <P className="summary" text={rowText(data.find((r) => r.line === focusLine)!, o!)} />}
      </Explain>
    </>
  )
}

function rowText(r: ByteRow, o: ObjectFile): string {
  const T = t().tc.as
  const bytes = r.bytes.slice(0, 16).map((b, k) => (r.unknown[k] ? '??' : hb(b))).join(' ')
  let s = T.line(r.text, bytes, `.${r.section}+0x${r.offset.toString(16)}`)
  for (const ri of r.relocs) {
    const rel = o.relocations[ri]
    s += T.lineReloc(rel.target.kind === 'extern' ? rel.target.name : (rel.target.label ?? '.' + rel.target.section), `${rel.type} (${T.relocTypes[rel.type]})`)
  }
  return s
}

function SymbolTable({ o }: { o: ObjectFile }) {
  const T = t().tc.as
  const syms = [...o.symbols].sort((a, b) => (a.section === 'UND' ? 1 : 0) - (b.section === 'UND' ? 1 : 0))
  return (
    <table className="tc-table mono objdump">
      <thead>
        <tr>
          {T.symCols.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {syms.map((s) => (
          <tr key={s.name + s.section} className={s.section === 'UND' ? 'is-und' : ''} title={s.section === 'UND' ? T.undTitle : undefined}>
            <td>{s.value.toString(16).padStart(16, '0')}</td>
            <td>{s.section === 'UND' ? '' : T.bind[s.binding]}</td>
            <td>{s.section === 'UND' ? '*UND*' : s.section === 'ABS' ? '*ABS*' : '.' + s.section}</td>
            <td>{s.name}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
