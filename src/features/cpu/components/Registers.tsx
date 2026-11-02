import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useSettings, type NumberFormat } from '../../../app/settings'
import type { RegChange } from '../../../core/cpu/state'
import { DISPLAY_ORDER, regName, registerViews } from '../../../core/registers'
import { trunc } from '../../../core/util'
import { t } from '../../../i18n'
import { formatValue } from '../format'
import type { View } from '../view'

type ByteState = '' | 'w' | 'z'

/** Which bytes (0 = least significant) a register write touched. */
function byteStates(changes: RegChange[]): ByteState[] {
  const s: ByteState[] = new Array(8).fill('')
  for (const c of changes) {
    if (c.high8) s[1] = 'w'
    else for (let i = 0; i < c.size; i++) s[i] = 'w'
    if (c.zeroExtended) for (let i = 4; i < 8; i++) s[i] = 'z'
  }
  return s
}

/** Hex/binary value with the written bytes emphasised. */
function SegmentedValue({ value, states, format }: { value: bigint; states: ByteState[] | null; format: NumberFormat }) {
  if (!states || (format !== 'hex' && format !== 'bin')) return <>{formatValue(value, 8, format)}</>
  const parts = []
  for (let b = 7; b >= 0; b--) {
    const byte = Number((value >> BigInt(b * 8)) & 0xffn)
    const txt = format === 'hex' ? byte.toString(16).toUpperCase().padStart(2, '0') : byte.toString(2).padStart(8, '0')
    parts.push(
      <span key={b} className={'byte' + (states[b] ? ` byte-${states[b]}` : '')}>
        {txt}
      </span>,
    )
    if (format === 'bin' && b > 0) parts.push(' ')
  }
  return (
    <>
      {format === 'hex' && <span className="prefix">0x</span>}
      {parts}
    </>
  )
}

function BitLayout({ index, value, changes }: { index: number; value: bigint; changes: RegChange[] }) {
  const views = registerViews(index)
  const written = new Set(changes.map((c) => c.name))
  const zeroed = changes.some((c) => c.zeroExtended)
  const seg = (hi: number, lo: number) => trunc(value >> BigInt(lo), 8) & ((1n << BigInt(hi - lo + 1)) - 1n)
  const segs: [number, number][] = [[63, 32], [31, 16], [15, 8], [7, 0]]
  const span = (size: number, high8: boolean): string => {
    if (high8) return '3 / 4'
    return size === 8 ? '1 / 5' : size === 4 ? '2 / 5' : size === 2 ? '3 / 5' : '4 / 5'
  }
  const rows: (typeof views)[] = [[views[0]], [views[1]], [views[2]], views.slice(3)]
  return (
    <div className="bitlayout" aria-label={t().registers.bits}>
      {segs.map(([hi, lo], i) => (
        <div key={'b' + i} className="bl-bits" style={{ gridColumn: i + 1 }}>
          {hi}–{lo}
        </div>
      ))}
      {segs.map(([hi, lo], i) => (
        <div key={'v' + i} className={'bl-val mono' + (i === 0 && zeroed ? ' bl-zeroed' : '')} style={{ gridColumn: i + 1 }}>
          {seg(hi, lo).toString(16).toUpperCase().padStart((hi - lo + 1) / 4, '0')}
        </div>
      ))}
      {rows.map((row, r) =>
        row.map((v) => (
          <div
            key={v.name}
            className={'bl-name' + (written.has(v.name) ? ' bl-written' : '')}
            style={{ gridColumn: span(v.size, v.high8), gridRow: r + 3 }}
          >
            {v.name.toUpperCase()}
          </div>
        )),
      )}
    </div>
  )
}

export function RegisterFile({ view }: { view: View }) {
  const format = useSettings((s) => s.format)
  const [expanded, setExpanded] = useState<number | null>(null)
  const R = t().registers
  const trace = view.trace
  return (
    <div className={'regfile' + (format === 'bin' ? ' is-bin' : '')} role="list" aria-label={t().panels.registers}>
      {DISPLAY_ORDER.map((i) => {
        const name = regName(i, 8).toUpperCase()
        const changes = trace?.regs.filter((r) => r.index === i) ?? []
        const changed = view.changedRegs.has(i)
        const prev = view.prevRegs.get(i)
        const isOpen = expanded === i
        const zeroExt = changed && changes.some((c) => c.zeroExtended) && prev !== undefined && prev >> 32n !== 0n
        const value = view.regs[i]
        const title = changed && prev !== undefined ? R.previous(formatValue(prev, 8, format)) : undefined
        return (
          <div key={i} role="listitem" className={'reg' + (changed ? ' is-changed' : '') + (isOpen ? ' is-open' : '')} data-flow={`reg-${i}`}>
            <button
              type="button"
              className="reg-row"
              onClick={() => setExpanded(isOpen ? null : i)}
              aria-expanded={isOpen}
              aria-label={`${name} = ${formatValue(value, 8, format)}. ${title ?? ''} ${R.expand(name)}`}
              title={title}
            >
              <ChevronRight size={12} className="reg-chevron" aria-hidden />
              <span className="reg-name">{name}</span>
              <span className="reg-value mono" key={changed ? view.version : 'same'}>
                <SegmentedValue value={value} states={changed ? byteStates(changes) : format === 'bin' ? new Array(8).fill('') : null} format={format} />
              </span>
              {zeroExt && (
                <span className="reg-tag" title={R.zeroExtended}>
                  ↑32=0
                </span>
              )}
            </button>
            {isOpen && <BitLayout index={i} value={value} changes={changed ? changes : []} />}
          </div>
        )
      })}
    </div>
  )
}
