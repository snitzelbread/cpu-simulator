import { AlertTriangle, Info } from 'lucide-react'
import { formatFault, t } from '../../../i18n'
import { explain } from '../../../explain/explain'
import { useCpu } from '../store'
import type { View } from '../view'
import { BinaryCalc } from './BinaryCalc'
import { renderCode } from './renderCode'
import { Panel } from './Panel'

const ADD_OPS = ['add', 'adc', 'inc']
const SUB_OPS = ['sub', 'sbb', 'cmp', 'dec']

export function ExplanationPanel({ view }: { view: View }) {
  const E = t().explain
  const notice = useCpu((s) => s.notice)
  const hasErrors = useCpu((s) => s.asm.errors.length > 0)
  const tr = view.phase === 0 || view.phase === 1 ? null : view.lastTrace
  const ex = tr && view.program ? explain(tr, view.program) : null
  const m = view.machine
  const op = tr?.instr.op ?? ''
  const calcOp = ADD_OPS.includes(op) ? 'add' : SUB_OPS.includes(op) ? 'sub' : null

  let summary: string
  if (view.phase === 0 && view.next) summary = t().micro.fetchText(`0x${view.next.address.toString(16).toUpperCase()}`, view.next.length, view.next.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '))
  else if (view.phase === 1 && view.next) summary = t().micro.decodeText(view.next.text, `0x${(view.next.address + view.next.length).toString(16).toUpperCase()}`, view.next.length)
  else if (ex) summary = ex.summary
  else if (hasErrors) summary = E.fixErrors
  else summary = E.initial

  return (
    <Panel title={t().panels.explanation} area="explain" className="explain-panel">
      <div className="explain">
        {notice?.kind === 'stepLimit' && (
          <div className="callout callout-warn" role="alert">
            <AlertTriangle size={16} aria-hidden /> {t().stepLimit(notice.steps)}
          </div>
        )}
        {notice?.kind === 'reset' && (
          <div className="callout callout-warn" role="status">
            <Info size={16} aria-hidden /> {t().codeChanged}
          </div>
        )}
        {ex?.fault && (
          <div className="callout callout-error" role="alert">
            <AlertTriangle size={16} aria-hidden />
            <span>
              <strong>{t().faultTitle}:</strong> {renderCode(ex.fault)}
            </span>
          </div>
        )}
        {!ex?.fault && m?.fault && !tr && (
          <div className="callout callout-error" role="alert">
            <AlertTriangle size={16} aria-hidden /> {formatFault(m.fault)}
          </div>
        )}
        <div className="explain-main">
          <div className="explain-text">
            {view.phase !== null && (
              <span className="phase-badge">{[t().micro.fetch, t().micro.decode, t().micro.execute, t().micro.writeback][view.phase]}</span>
            )}
            <p className="explain-summary" aria-live="polite">
              {renderCode(summary)}
            </p>
            {ex && ex.notes.length > 0 && view.phase !== 2 && (
              <ul className="explain-notes">
                {ex.notes.map((n, i) => (
                  <li key={i}>
                    <Info size={13} aria-hidden /> {renderCode(n)}
                  </li>
                ))}
              </ul>
            )}
            {m?.done && !ex?.fault && <p className="explain-ended">{E.ended}</p>}
          </div>
          {ex && ex.flags.length > 0 && (
            <div className="explain-side">
              {tr?.alu && calcOp && tr.alu.b !== undefined && <BinaryCalc alu={tr.alu} op={calcOp} />}
              <ul className="flag-reasons" aria-label={E.flagsHeading}>
                {ex.flags.map((f) => (
                  <li key={f.flag} className={(f.before !== f.after ? 'is-changed ' : '') + (f.undefined ? 'is-undef' : '')}>
                    <span className="fr-flag mono">{f.flag}</span>
                    <span className="fr-val mono">
                      {f.before ? 1 : 0}→{f.after ? 1 : 0}
                    </span>
                    <span className="fr-reason">{f.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Panel>
  )
}
