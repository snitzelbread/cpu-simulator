import { ChevronsRight, CornerDownRight, Pause, Play, RotateCcw, StepBack, StepForward, TextCursorInput } from 'lucide-react'
import type { ReactNode } from 'react'
import { t } from '../../../i18n'
import { SHORTCUTS, type Shortcut } from '../shortcuts'
import { SPEEDS, useCpu } from '../store'
import { useView } from '../view'

function Btn(props: { label: string; shortcut?: Shortcut; onClick: () => void; disabled?: boolean; icon: ReactNode; primary?: boolean; pressed?: boolean }) {
  const title = props.shortcut ? t().shortcutHint(props.label, props.shortcut.label) : props.label
  return (
    <button
      type="button"
      className={'btn' + (props.primary ? ' btn-primary' : '')}
      onClick={props.onClick}
      disabled={props.disabled}
      title={title}
      aria-label={title}
      aria-pressed={props.pressed}
    >
      {props.icon}
      <span className="btn-label">{props.label}</span>
      {props.shortcut && <kbd>{props.shortcut.label}</kbd>}
    </button>
  )
}

export function Controls() {
  const C = t().controls
  const st = useCpu()
  const view = useView()
  const m = view.machine
  const done = !m || m.done
  const microBusy = st.microMode && st.microPhase !== null && st.microPhase !== 3
  const canBack = !!m && !st.running && (m.canStepBack() || (st.microMode && st.microPhase !== null))
  const status = statusText()

  function statusText(): { text: string; kind: string } {
    const S = t().status
    if (!st.asm.program) return { text: S.errors(st.asm.errors.length), kind: 'error' }
    if (!m) return { text: S.ready, kind: 'idle' }
    if (st.running) return { text: S.running, kind: 'running' }
    if (m.status === 'exited') return { text: S.exited(m.exitCode ?? 0), kind: 'ok' }
    if (m.status === 'halted') return { text: S.halted, kind: 'ok' }
    if (m.status === 'faulted') return { text: S.faulted, kind: 'error' }
    return { text: m.stepCount ? S.paused : S.ready, kind: 'idle' }
  }

  return (
    <div className="controls" role="toolbar" aria-label={t().ui.controlsLabel}>
      <div className="control-group">
        <Btn label={C.stepBack} shortcut={SHORTCUTS.stepBack} onClick={st.stepBack} disabled={!canBack} icon={<StepBack size={16} aria-hidden />} />
        <Btn label={C.step} shortcut={SHORTCUTS.step} onClick={st.step} disabled={(done && !microBusy) || st.running} icon={<StepForward size={16} aria-hidden />} primary />
        <Btn label={C.stepOver} shortcut={SHORTCUTS.stepOver} onClick={st.stepOver} disabled={done || st.running || microBusy} icon={<CornerDownRight size={16} aria-hidden />} />
        {st.running ? (
          <Btn label={C.pause} shortcut={SHORTCUTS.run} onClick={st.pause} icon={<Pause size={16} aria-hidden />} />
        ) : (
          <Btn label={C.run} shortcut={SHORTCUTS.run} onClick={st.run} disabled={done || microBusy} icon={<Play size={16} aria-hidden />} />
        )}
        <Btn label={C.runToCursor} shortcut={SHORTCUTS.runToCursor} onClick={st.runToCursor} disabled={done || st.running || microBusy} icon={<TextCursorInput size={16} aria-hidden />} />
        <Btn label={C.reset} shortcut={SHORTCUTS.reset} onClick={st.reset} disabled={!st.asm.program} icon={<RotateCcw size={16} aria-hidden />} />
      </div>

      <label className="speed" title={C.speed}>
        <ChevronsRight size={16} aria-hidden />
        <span className="visually-hidden">{C.speed}</span>
        <input
          type="range"
          min={0}
          max={SPEEDS.length - 1}
          value={st.speedIndex}
          onChange={(e) => st.setSpeedIndex(Number(e.target.value))}
          aria-valuetext={C.stepsPerSecond(SPEEDS[st.speedIndex])}
        />
        <span className="speed-value mono">{C.stepsPerSecond(SPEEDS[st.speedIndex])}</span>
      </label>

      <label className="switch" title={t().shortcutHint(C.microStep, SHORTCUTS.micro.label)}>
        <input type="checkbox" role="switch" checked={st.microMode} onChange={(e) => st.setMicroMode(e.target.checked)} disabled={st.running} />
        <span className="switch-track" aria-hidden />
        <span>{C.microStep}</span>
      </label>

      <div className={`status-pill status-${status.kind}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden />
        <span>{status.text}</span>
        {m && <span className="status-step mono">{t().status.step(m.stepCount)}</span>}
      </div>
    </div>
  )
}
