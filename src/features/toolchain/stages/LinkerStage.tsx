import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../../i18n'
import { relocTargetText } from '../../../core/object'
import type { LinkStep } from '../../../toolchain/linker'
import { Panel } from '../../cpu/components/Panel'
import { ErrorList, Explain, P } from '../components/common'
import { currentIndex } from '../steps'
import { useToolchain } from '../store'

const hx = (n: number) => '0x' + n.toString(16).toUpperCase()
const hb = (b: number) => b.toString(16).padStart(2, '0')

export function LinkerStage() {
  const T = t().tc.ld
  const st = useToolchain()
  const b = st.build
  const ld = b.ld
  const objects = b.objects
  const steps = ld?.steps ?? []
  const done = st.pos === null ? steps.length : st.pos
  const cur = st.pos !== null ? currentIndex(st.pos, steps.length) : -1
  const step: LinkStep | undefined = cur >= 0 ? steps[cur] : undefined
  const applied = steps.slice(0, done)

  const resolvedUpTo = useMemo(() => {
    const set = new Set<string>()
    for (const s of applied) if (s.kind === 'resolve') set.add(`${s.resolution.obj}:${s.resolution.name}`)
    return set
  }, [applied])
  const patchedUpTo = useMemo(() => new Set(applied.filter((s) => s.kind === 'patch').map((s) => (s as Extract<LinkStep, { kind: 'patch' }>).patch)), [applied])
  const placed = useMemo(() => new Set(applied.filter((s) => s.kind === 'layout').map((s) => (s as Extract<LinkStep, { kind: 'layout' }>).placement)), [applied])

  return (
    <>
      <div className="tc-stage">
        <Panel title={T.input} area="in" className="tc-in">
          {objects.length ? (
            <ObjectCards resolvedUpTo={resolvedUpTo} current={step} />
          ) : (
            <p className="empty">{t().tc.notReached(t().tc.stages.ld)}</p>
          )}
        </Panel>
        <Panel title={T.output} area="out" className="tc-out">
          {ld && (
            <div className="obj-view">
              <section className="obj-block">
                <h3>{T.layout}</h3>
                <ol className="layout-list mono">
                  {ld.placements.map((p, i) => (
                    <li key={i} className={`lay lay-${p.section}` + (placed.has(p) ? '' : ' is-pending') + (step?.kind === 'layout' && step.placement === p ? ' is-current' : '')}>
                      <span className="lay-addr">{hx(p.start)}</span>
                      <span className="lay-sec">.{p.section}</span>
                      <span className="lay-obj">{objects[p.obj].name}</span>
                      <span className="lay-size">{p.size} B</span>
                    </li>
                  ))}
                </ol>
              </section>
              <section className="obj-block">
                <h3>{T.patches}</h3>
                <table className="tc-table mono">
                  <tbody>
                    {ld.patches.map((p, i) => {
                      const on = patchedUpTo.has(p)
                      return (
                        <tr key={i} className={step?.kind === 'patch' && step.patch === p ? 'is-current' : ''}>
                          <td>{objects[p.obj].name}</td>
                          <td>{hx(p.address)}</td>
                          <td title={t().tc.as.relocTypes[p.reloc.type]}>{p.reloc.type.replace('R_X86_64_', '')}</td>
                          <td>{relocTargetText(p.reloc.target, p.reloc.addend)}</td>
                          <td className="patch-bytes">
                            {on ? p.bytes.map(hb).join(' ') : <span className="byte-unknown">{p.bytes.map(() => '??').join(' ')}</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </section>
            </div>
          )}
          <ErrorList errors={b.stoppedAt === 'ld' ? b.errors : []} />
        </Panel>
      </div>
      <Explain>
        <P className="muted" text={T.intro} />
        {step && <P className="summary" text={stepText(step, objects.map((o) => o.name))} />}
        {step?.kind === 'patch' && step.patch.reloc.pcRel && <P className="muted" text={T.pcRelHint} />}
      </Explain>
    </>
  )
}

function stepText(s: LinkStep, names: string[]): string {
  const T = t().tc.ld
  switch (s.kind) {
    case 'layout': return T.layout_(names[s.placement.obj], s.placement.section, hx(s.placement.start), s.placement.size)
    case 'symbol': return T.symbol(s.symbol.name, names[s.symbol.obj], hx(s.symbol.address))
    case 'resolve': {
      const r = s.resolution
      if (r.definedIn >= 0) return T.resolve(r.name, names[r.obj], names[r.definedIn], hx(r.address!))
      return T.unresolved(r.name, names[r.obj])
    }
    case 'patch': {
      const p = s.patch
      return T.patch(names[p.obj], hx(p.address), p.reloc.type, relocTargetText(p.reloc.target, p.reloc.addend), hx(Number(BigInt.asUintN(64, p.value))), p.bytes.map(hb).join(' '))
    }
    case 'entry': return T.entry(hx(s.address))
  }
}

/** One card per object file; arrows connect *UND* symbols with their definitions. */
function ObjectCards({ resolvedUpTo, current }: { resolvedUpTo: Set<string>; current?: LinkStep }) {
  const T = t().tc.ld
  const st = useToolchain()
  const b = st.build
  const ld = b.ld!
  const objects = b.objects
  const box = useRef<HTMLDivElement>(null)
  const [arrows, setArrows] = useState<{ d: string; cls: string }[]>([])

  const usedExterns = useMemo(
    () => objects.map((o) => new Set(o.relocations.filter((r) => r.target.kind === 'extern').map((r) => (r.target as { name: string }).name))),
    [objects],
  )

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const draw = () => {
      const base = el.getBoundingClientRect()
      const out: { d: string; cls: string }[] = []
      for (const r of ld.resolutions) {
        if (r.definedIn < 0 || !resolvedUpTo.has(`${r.obj}:${r.name}`)) continue
        const a = el.querySelector<HTMLElement>(`[data-und="${r.obj}:${r.name}"]`)
        const z = el.querySelector<HTMLElement>(`[data-def="${r.definedIn}:${r.name}"]`)
        if (!a || !z) continue
        const ra = a.getBoundingClientRect()
        const rz = z.getBoundingClientRect()
        const right = rz.left > ra.left
        const x1 = (right ? ra.right : ra.left) - base.left + el.scrollLeft
        const y1 = ra.top + ra.height / 2 - base.top + el.scrollTop
        const x2 = (right ? rz.left : rz.right) - base.left + el.scrollLeft
        const y2 = rz.top + rz.height / 2 - base.top + el.scrollTop
        const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (right ? 1 : -1)
        const isCur = current?.kind === 'resolve' && current.resolution === r
        out.push({ d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, cls: isCur ? 'ld-arrow is-current' : 'ld-arrow' })
      }
      setArrows(out)
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    el.addEventListener('scroll', draw)
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', draw)
    }
  }, [ld, resolvedUpTo, current])

  return (
    <div className="obj-cards" ref={box}>
      {objects.map((o, i) => {
        const defs = o.symbols.filter((s) => s.binding === 'global' && s.section !== 'UND')
        const und = o.symbols.filter((s) => s.section === 'UND')
        const runtime = i === 0 || i === objects.length - 1
        return (
          <article key={o.name} className={'obj-card' + (runtime ? ' is-runtime' : '')}>
            <header className="mono">{o.name}</header>
            <ul className="obj-secs mono">
              {(['text', 'data', 'bss'] as const).map((s) => (o.sections[s].size ? <li key={s}>.{s} {o.sections[s].size} B</li> : null))}
            </ul>
            <ul className="obj-syms mono">
              {defs.map((s) => (
                <li key={s.name} data-def={`${i}:${s.name}`} className={current?.kind === 'symbol' && current.symbol.obj === i && current.symbol.name === s.name ? 'is-current' : ''}>
                  <span className="sym-bind">g</span> {s.name}
                </li>
              ))}
              {und.map((s) => {
                const r = ld.resolutions.find((x) => x.obj === i && x.name === s.name)
                const missing = r && r.definedIn < 0 && usedExterns[i].has(s.name)
                const unused = r && r.definedIn < 0 && !usedExterns[i].has(s.name)
                return (
                  <li
                    key={s.name}
                    data-und={`${i}:${s.name}`}
                    className={'is-und' + (missing ? ' is-missing' : '') + (current?.kind === 'resolve' && current.resolution === r ? ' is-current' : '')}
                    title={missing ? T.missing : unused ? T.unused : r ? T.definedIn(objects[r.definedIn].name) : undefined}
                  >
                    <span className="sym-bind">*UND*</span> {s.name}
                    {missing && <span className="sym-flag"> {T.missing}</span>}
                    {unused && <span className="sym-flag muted"> {T.unused}</span>}
                  </li>
                )
              })}
            </ul>
          </article>
        )
      })}
      <svg className="ld-arrows" aria-hidden>
        <defs>
          <marker id="ld-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" />
          </marker>
        </defs>
        {arrows.map((a, i) => (
          <path key={i} d={a.d} className={a.cls} markerEnd="url(#ld-head)" />
        ))}
      </svg>
    </div>
  )
}
