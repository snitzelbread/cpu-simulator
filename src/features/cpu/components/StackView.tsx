import { useEffect, useRef } from 'react'
import { useSettings } from '../../../app/settings'
import { symbolize } from '../../../core/symbols'
import { t } from '../../../i18n'
import { formatValue, hexAddr } from '../format'
import type { View } from '../view'
import { Panel } from './Panel'
import { renderCode } from './renderCode'

const MAX_SLOTS = 96

export function StackView({ view }: { view: View }) {
  const S = t().stack
  const format = useSettings((s) => s.format)
  const listRef = useRef<HTMLOListElement>(null)
  const m = view.machine
  const top = view.program?.stackTop ?? 0
  const rsp = Number(view.regs[4])
  const rbp = Number(view.regs[5])
  const inStack = (a: number) => !!m && m.inStack(a)

  const slots: number[] = []
  if (m) {
    let low = inStack(rsp) ? rsp : top
    if (inStack(rbp) && rbp < low) low = rbp
    low -= 16 // show two free slots below RSP
    for (let a = top - 8; a >= low && slots.length < MAX_SLOTS; a -= 8) slots.push(a)
  }

  const tr = view.trace
  const writes = new Set(tr?.mem.filter((x) => x.kind === 'write' && inStack(x.address)).map((x) => x.address & ~7))
  const reads = new Set(tr?.mem.filter((x) => x.kind === 'read' && !x.fetch && inStack(x.address)).map((x) => x.address & ~7))
  const popped = tr && (tr.instr.op === 'pop' || tr.instr.op === 'ret') ? Number(tr.regs.find((r) => r.index === 4)?.before ?? -1) : -1

  useEffect(() => {
    listRef.current?.querySelector('.is-rsp')?.scrollIntoView({ block: 'nearest' })
  }, [view.version, rsp])

  return (
    <Panel title={t().panels.stack} area="stack" actions={<span className="panel-hint">{S.growsDown}</span>}>
      {!m ? null : (
        <ol className="stack" ref={listRef} aria-label={t().panels.stack}>
          <li className="stack-top-marker">
            <span className="mono">{hexAddr(top)}</span> {S.top}
          </li>
          {rsp === top && <li className="stack-empty">{S.empty}</li>}
          {slots.map((a) => {
            const v = m.mem.read(a, 8)
            const free = a < rsp
            const origin = m.stackOrigins.get(a)
            const isRsp = a === rsp
            const isRbp = a === rbp
            let note = ''
            if (!free && origin?.kind === 'call') {
              const sym = symbolize(m.program, Number(v))
              note = S.returnAddress(sym ?? hexAddr(v))
            } else if (!free && origin) note = S.pushedBy(origin.text)
            const rel = inStack(rbp) && Math.abs(a - rbp) <= 0x40 && !free ? (a === rbp ? 'rbp' : `rbp${a > rbp ? '+' : '−'}0x${Math.abs(a - rbp).toString(16).toUpperCase()}`) : ''
            const cls = [
              'slot',
              free ? 'is-free' : '',
              isRsp ? 'is-rsp' : '',
              writes.has(a) ? 'is-written' : '',
              reads.has(a) ? 'is-read' : '',
              a === popped ? 'is-popped' : '',
              origin?.kind === 'call' && !free ? 'is-ret' : '',
              writes.has(a) && isRsp ? 'is-pushed' : '',
            ].join(' ')
            return (
              <li key={writes.has(a) ? `${a}-${view.version}` : a} className={cls}>
                <span className="slot-ptrs">
                  {isRsp && <span className="ptr ptr-rsp">RSP →</span>}
                  {isRbp && <span className="ptr ptr-rbp">RBP →</span>}
                </span>
                <span className="slot-addr mono">{a.toString(16).toUpperCase()}</span>
                <span className="slot-cell">
                  <span className="slot-value mono">{formatValue(v, 8, format === 'bin' ? 'hex' : format)}</span>
                  {note && <span className="slot-note">{renderCode(note)}</span>}
                </span>
                <span className="slot-rel mono">{rel}</span>
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}
