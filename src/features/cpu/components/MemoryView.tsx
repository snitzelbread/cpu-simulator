import { useEffect, useMemo, useState } from 'react'
import type { MemAccess } from '../../../core/cpu/state'
import { symbolize } from '../../../core/symbols'
import { t } from '../../../i18n'
import { hexAddr, hexByte } from '../format'
import type { View } from '../view'
import { Panel } from './Panel'

type Region = 'data' | 'stack' | 'text' | 'custom'

interface Range {
  start: number
  end: number
}

const MAX_BYTES = 4096

function regionRange(view: View, region: Region, custom: number): Range | null {
  const p = view.program
  if (!p) return null
  const al = (a: number) => a & ~15
  const { text, data, bss } = p.sections
  switch (region) {
    case 'data': {
      if (!data.size && !bss.size) return null
      const start = al(data.size ? data.start : bss.start)
      return { start, end: Math.min(bss.start + bss.size, start + MAX_BYTES) }
    }
    case 'text':
      return { start: text.start, end: Math.min(text.start + text.size, text.start + MAX_BYTES) }
    case 'stack': {
      const rsp = Number(view.regs[4])
      const start = al(Math.max(Math.min(rsp, p.stackTop) - 32, p.stackTop - MAX_BYTES))
      return { start, end: p.stackTop }
    }
    case 'custom':
      return { start: al(custom), end: al(custom) + 256 }
  }
}

function regionOf(view: View, a: number): Region {
  const p = view.program!
  const { text, data, bss } = p.sections
  if (a >= text.start && a < text.start + text.size) return 'text'
  if (a >= (data.size ? data.start : bss.start) && a < bss.start + bss.size) return 'data'
  if (view.machine?.inStack(a)) return 'stack'
  return 'custom'
}

/** Show bytes in memory order and how they combine into a little-endian value. */
function EndianStrip({ access, view }: { access: MemAccess; view: View }) {
  const bytes = Array.from(view.machine!.mem.readBytes(access.address, access.size))
  const sym = view.program ? symbolize(view.program, access.address) : undefined
  const value = access.kind === 'write' ? access.value : access.value
  return (
    <div className="endian" aria-label={t().memory.littleEndian}>
      <span className="endian-title">
        {t().memory.lastAccess}: {t().ui.access(access.kind, access.size, hexAddr(access.address) + (sym ? ` (${sym})` : ''))}
      </span>
      <span className="endian-bytes mono">
        {bytes.map((b, i) => (
          <span key={i} className="endian-byte">
            <span className="endian-off">+{i}</span>
            {hexByte(b)}
          </span>
        ))}
      </span>
      <span className="endian-arrow" aria-hidden>
        ⟲
      </span>
      <span className="endian-value mono">
        {'0x' +
          [...bytes]
            .reverse()
            .map(hexByte)
            .join('')}
        <span className="endian-dec"> = {value.toString()}</span>
      </span>
    </div>
  )
}

export function MemoryView({ view }: { view: View }) {
  const M = t().memory
  const [region, setRegion] = useState<Region>('data')
  const [custom, setCustom] = useState(0x8000)
  const [gotoText, setGotoText] = useState('')
  const program = view.program
  const tr = view.trace
  const lastAccess = tr?.mem.filter((m) => !m.fetch && m.size <= 8).at(-1)

  // follow memory accesses into other regions
  useEffect(() => {
    if (!lastAccess || !program) return
    const r = regionOf(view, lastAccess.address)
    if (r === 'stack') return // the stack has its own panel
    if (r === 'custom') {
      setCustom(lastAccess.address)
      setRegion('custom')
    } else if (r !== region) setRegion(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.version])

  // programs without .data/.bss: show the stack instead of an empty view
  const shown: Region = region === 'data' && program && !program.sections.data.size && !program.sections.bss.size ? 'stack' : region
  const range = regionRange(view, shown, custom)

  // Fetch phase: show the code bytes RIP points at
  useEffect(() => {
    if (view.phase === 0) setRegion('text')
  }, [view.phase])
  const labels = useMemo(() => {
    const map = new Map<number, string[]>()
    for (const s of program?.symbols ?? []) {
      if (s.kind !== 'label') continue
      const a = Number(s.value)
      map.set(a, [...(map.get(a) ?? []), s.name])
    }
    return map
  }, [program])

  const accessed = new Map<number, 'read' | 'write'>()
  for (const m of tr?.mem ?? []) {
    if (m.fetch) continue
    for (let i = 0; i < m.size && i < 64; i++) {
      if (m.kind === 'write' || !accessed.has(m.address + i)) accessed.set(m.address + i, m.kind)
    }
  }
  const fetchRange = view.phase === 0 && view.next ? { start: view.next.address, end: view.next.address + view.next.length } : null

  const rows: number[] = []
  if (range) for (let a = range.start; a < range.end; a += 16) rows.push(a)

  const tabs: [Region, string][] = [
    ['data', `${M.sections.data} / ${M.sections.bss}`],
    ['stack', M.sections.stack],
    ['text', M.sections.text],
  ]

  return (
    <Panel
      title={t().panels.memory}
      area="memory"
      actions={
        <div className="mem-actions">
          <div className="segmented" role="tablist">
            {tabs.map(([r, label]) => (
              <button key={r} type="button" role="tab" aria-selected={shown === r} className={shown === r ? 'is-active' : ''} onClick={() => setRegion(r)}>
                {label}
              </button>
            ))}
          </div>
          <form
            className="mem-goto"
            onSubmit={(e) => {
              e.preventDefault()
              const v = parseInt(gotoText.replace(/^0x/i, '').replace(/_/g, ''), 16)
              if (!Number.isNaN(v)) {
                setCustom(v)
                setRegion('custom')
              }
            }}
          >
            <input aria-label={M.goto} placeholder={M.goto} value={gotoText} onChange={(e) => setGotoText(e.target.value)} className="mono" />
          </form>
        </div>
      }
    >
      {!view.machine ? null : !range ? (
        <p className="empty">{M.noData}</p>
      ) : (
        <div className="memory">
          <div className="hex-scroll">
            <table className="hex" aria-label={t().panels.memory}>
              <thead>
                <tr>
                  <th className="hex-addr">{M.address}</th>
                  <th className="hex-label" />
                  {Array.from({ length: 16 }, (_, i) => (
                    <th key={i} className={'hex-col' + (i === 8 ? ' gap' : '')}>
                      {i.toString(16).toUpperCase()}
                    </th>
                  ))}
                  <th className="hex-ascii">{M.ascii}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const bytes = view.machine!.mem.readBytes(row, 16)
                  const rowLabels: string[] = []
                  for (let i = 0; i < 16; i++) rowLabels.push(...(labels.get(row + i) ?? []))
                  return (
                    <tr key={row}>
                      <td className="hex-addr mono">{row.toString(16).toUpperCase()}</td>
                      <td className="hex-label">
                        {rowLabels.map((l) => (
                          <span key={l} className="label-tag">
                            {l}
                          </span>
                        ))}
                      </td>
                      {Array.from(bytes, (b, i) => {
                        const a = row + i
                        const acc = accessed.get(a)
                        const lab = labels.get(a)
                        const isFetch = fetchRange && a >= fetchRange.start && a < fetchRange.end
                        return (
                          <td
                            key={i}
                            className={['hex-byte mono', i === 8 ? 'gap' : '', acc ? `is-${acc}` : '', lab ? 'is-labelled' : '', isFetch ? 'is-fetch' : '', b === 0 ? 'is-zero' : ''].join(' ')}
                            title={`${hexAddr(a)}${lab ? ' ' + lab.join(', ') : ''} = ${b}`}
                          >
                            {hexByte(b)}
                          </td>
                        )
                      })}
                      <td className="hex-ascii mono">{Array.from(bytes, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {lastAccess && lastAccess.size > 1 ? <EndianStrip access={lastAccess} view={view} /> : <p className="endian-hint">{M.littleEndian}</p>}
        </div>
      )}
    </Panel>
  )
}
