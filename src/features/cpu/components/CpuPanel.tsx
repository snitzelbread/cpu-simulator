import { useMemo, useRef } from 'react'
import { useSettings } from '../../../app/settings'
import { FLAG_NAMES, type FlagName } from '../../../core/cpu/state'
import { symbolize } from '../../../core/symbols'
import { trunc } from '../../../core/util'
import { t } from '../../../i18n'
import { formatValue, hexAddr, hexByte } from '../format'
import { useCpu } from '../store'
import type { View } from '../view'
import { FlowOverlay } from './FlowOverlay'
import { computeFlows, type Flow } from './flows'
import { Panel } from './Panel'
import { RegisterFile } from './Registers'
import { renderCode } from './renderCode'

const ALU_LABEL: Record<string, string> = {
  '+': 'ADD', '-': 'SUB', '&': 'AND', '|': 'OR', '^': 'XOR', '~': 'NOT', neg: 'NEG', '<<': 'SHL', '>>>': 'SHR',
  '>>': 'SAR', rol: 'ROL', ror: 'ROR', '*': 'MUL', '/': 'DIV', test: 'AND',
}

function MicroPhases({ phase }: { phase: number | null }) {
  const M = t().micro
  const names = [M.fetch, M.decode, M.execute, M.writeback]
  return (
    <ol className="micro-phases" aria-label={t().controls.microStep}>
      {names.map((n, i) => (
        <li key={n} className={phase === i ? 'is-active' : phase !== null && i < phase ? 'is-done' : ''} aria-current={phase === i ? 'step' : undefined}>
          <span className="micro-num">{i + 1}</span>
          {n}
        </li>
      ))}
    </ol>
  )
}

function Flags({ view }: { view: View }) {
  const tr = view.trace
  return (
    <div className="flags" role="list" aria-label={t().panels.flags} data-flow="flags">
      {FLAG_NAMES.map((f: FlagName) => {
        const v = view.flags[f]
        const changed = !!tr && tr.flagsBefore[f] !== tr.flagsAfter[f]
        const undef = !!tr && tr.flagsUndefined.includes(f)
        const affected = !!tr && tr.flagsAffected.includes(f)
        const info = t().flags[f]
        const desc = `${f} (${info.name}) = ${v ? 1 : 0}. ${info.desc}${undef ? ' ' + t().flagUndefined : ''}`
        return (
          <div
            key={f}
            role="listitem"
            tabIndex={0}
            className={'flag tip' + (v ? ' is-set' : '') + (changed ? ' is-changed' : '') + (undef ? ' is-undef' : '') + (affected ? ' is-affected' : '')}
            data-tip={`${info.name}: ${info.desc}`}
            aria-label={desc}
          >
            <span className="flag-lamp" aria-hidden key={changed ? view.version : 'same'}>
              {v ? '1' : '0'}
            </span>
            <span className="flag-name">{f}</span>
            {undef && <span className="flag-undef" aria-hidden>?</span>}
          </div>
        )
      })}
    </div>
  )
}

function Alu({ view }: { view: View }) {
  const format = useSettings((s) => s.format)
  const alu = view.phase === 0 || view.phase === 1 ? undefined : view.trace?.alu
  const size = alu?.size ?? 8
  // compact: no leading zeros, so 64-bit operands fit into the ALU ports
  const f = (v?: bigint) => (v === undefined ? '' : format === 'hex' || format === 'bin' ? '0x' + trunc(v, size).toString(16).toUpperCase() : formatValue(v, size, format))
  return (
    <div className={'alu' + (alu ? ' is-active' : '')}>
      <div className="alu-inputs">
        <div className="alu-port mono" data-flow="alu-a">
          <span className="alu-port-label">A</span>
          {alu ? f(alu.a) : '—'}
        </div>
        <div className="alu-port mono" data-flow="alu-b">
          <span className="alu-port-label">B</span>
          {alu?.b !== undefined ? f(alu.b) : '—'}
          {alu?.carryIn && <span className="alu-carry">+CF</span>}
        </div>
      </div>
      <svg className="alu-shape" viewBox="0 0 200 64" preserveAspectRatio="none" aria-hidden>
        <path d="M2,2 L80,2 L100,22 L120,2 L198,2 L160,62 L40,62 Z" />
      </svg>
      <div className="alu-op" aria-live="polite">
        <span className="alu-title">{t().panels.alu}</span>
        <span className="alu-opname">{alu ? ALU_LABEL[alu.op] ?? alu.op : t().ui.aluIdle}</span>
      </div>
      <div className="alu-port alu-out mono" data-flow="alu-out">
        <span className="alu-port-label">=</span>
        {alu ? f(alu.result) : '—'}
        {alu?.discarded && <span className="alu-discard">{t().ui.discarded}</span>}
      </div>
    </div>
  )
}

function InstructionRegister({ view }: { view: View }) {
  const M = t().micro
  const ins = view.next
  const phase = view.phase
  const lines: string[] = []
  if (ins && phase === 0) lines.push(M.fetchText(hexAddr(ins.address), ins.length, ins.bytes.map(hexByte).join(' ')))
  if (ins && phase === 1) lines.push(M.decodeText(ins.text, hexAddr(ins.address + ins.length), ins.length))
  if (phase === 2) lines.push(M.executeText)
  if (phase === 3) lines.push(M.writebackText)
  return (
    <div className="ir" data-flow="ir">
      <div className="ir-head">
        <span className="ir-label" title={t().ui.irTitle}>IR</span>
        <code className="ir-text">{phase === 0 ? '…' : ins?.text ?? '—'}</code>
        <span className={'ir-bytes mono' + (phase === 0 ? ' is-fetching' : '')}>{ins?.bytes.map(hexByte).join(' ')}</span>
      </div>
      {lines.length > 0 && <p className="ir-micro">{renderCode(lines[0])}</p>}
    </div>
  )
}

export function CpuPanel({ view }: { view: View }) {
  const ref = useRef<HTMLDivElement>(null)
  const microMode = useCpu((s) => s.microMode)
  const animations = useSettings((s) => s.animations)
  const R = t().registers
  const flows = useMemo((): Flow[] => {
    // micro-steps: Fetch = RIP → address bus → bytes → IR; Decode = RIP += length
    if (view.phase === 0) return [{ from: 'rip', to: 'bus', kind: 'mem', stage: 0 }, { from: 'bus', to: 'ir', kind: 'mem', stage: 1 }]
    if (view.phase === 1) return [{ from: 'ir', to: 'rip', kind: 'ctrl', stage: 0 }]
    if (!view.trace) return []
    const all = computeFlows(view.trace)
    return view.phase === 2 ? all.filter((f) => f.stage === 0) : all
  }, [view.trace, view.phase])
  const ripChanged = (!!view.lastTrace && view.phase === null) || view.phase === 1 || view.phase === 3
  const sym = view.program ? symbolize(view.program, view.rip) : undefined
  const busActive = view.phase === 0 || (!!view.trace && view.trace.mem.some((m) => !m.fetch))
  const busText = view.phase === 0 && view.next ? view.next.bytes.map(hexByte).join(' ') : ''

  return (
    <Panel title={t().panels.cpu} area="cpu" className="cpu-panel" actions={microMode ? <MicroPhases phase={view.phase} /> : undefined}>
      <div className="cpu-die" ref={ref}>
        <div className="cpu-top">
          <div className={'rip-box tip' + (ripChanged ? ' is-changed' : '')} data-flow="rip" data-tip={R.rip} tabIndex={0} aria-label={`RIP = ${hexAddr(view.rip)} ${sym ?? ''}. ${R.rip}`}>
            <span className="box-label">RIP</span>
            <span className="mono rip-value" key={view.version}>{hexAddr(view.rip, 16)}</span>
            {sym && <span className="rip-sym">{sym}</span>}
          </div>
          <div className="rflags-box tip" data-tip={R.rflags} tabIndex={0} aria-label={`RFLAGS = ${view.machine ? hexAddr(view.machine.rflags) : ''}`}>
            <span className="box-label">RFLAGS</span>
            <span className="mono">{view.machine ? hexAddr(view.machine.rflags, 4) : '—'}</span>
          </div>
        </div>
        <InstructionRegister view={view} />
        <div className="cpu-main">
          <RegisterFile view={view} />
          <div className="cpu-side">
            <Alu view={view} />
            <Flags view={view} />
            <div className={'bus' + (busActive ? ' is-active' : '') + (view.phase === 0 ? ' is-fetch' : '')} data-flow="bus">
              <span className="bus-label">{t().panels.bus} ⇄ {t().panels.memory}</span>
              {busText && <span className="bus-bytes mono">{busText}</span>}
            </div>
          </div>
        </div>
        <FlowOverlay container={ref} flows={flows} version={view.version * 4 + (view.phase ?? 0)} animate={animations} />
      </div>
    </Panel>
  )
}
