import { useEffect, useRef } from 'react'
import { t } from '../../../i18n'
import { useCpu } from '../store'

/** For programs from the C toolchain: the C source with the line that is currently executing. */
export function CSourcePane() {
  const linked = useCpu((s) => s.linked)
  const machine = useCpu((s) => s.machine)
  useCpu((s) => s.version)
  const ref = useRef<HTMLOListElement>(null)
  const ins = machine ? (machine.done ? machine.history.at(-1)?.instr : machine.current) : undefined
  const loc = linked && ins ? linked.cLines[ins.line - 1] : null
  const fileName = loc?.file ?? linked?.cFiles[0]?.name
  const file = linked?.cFiles.find((f) => f.name === fileName)

  useEffect(() => {
    ref.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' })
  }, [loc?.file, loc?.line])

  if (!linked || !file) return null
  return (
    <div className="c-source-pane" aria-label={t().tc.cpu.cSource}>
      <div className="c-source-head">
        <span className="mono">{file.name}</span>
        <span className="panel-hint">{loc ? t().tc.cpu.cLine(loc.file, loc.line) : t().tc.cpu.noCLine}</span>
      </div>
      <ol className="c-source-lines mono" ref={ref}>
        {file.text.replace(/\n$/, '').split('\n').map((l, i) => (
          <li key={i} className={loc && loc.line === i + 1 ? 'is-current' : ''} aria-current={loc && loc.line === i + 1 ? 'true' : undefined}>
            <span className="ln">{i + 1}</span>
            <span className="tx">{l || ' '}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
