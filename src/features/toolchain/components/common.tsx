import { Check, ChevronRight, CircleSlash, FilePlus2, Pause, Pencil, Play, Rocket, SkipBack, SkipForward, StepBack, StepForward, Trash2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { t, formatDiag } from '../../../i18n'
import type { Diagnostic } from '../../../toolchain/diagnostics'
import { SYSTEM_HEADERS } from '../../../toolchain/project'
import { renderCode } from '../../cpu/components/renderCode'
import { stepCount } from '../steps'
import { useToolchain, type StageId } from '../store'
import { STAGES, stageState } from './util'

export function PipelineBar() {
  const T = t().tc
  const st = useToolchain()
  const b = st.build
  const units = b.units
  const artifacts: Record<StageId, string> = {
    pp: units.map((u) => u.file.replace(/\.c$/, '.i')).join(' '),
    cc: units.map((u) => u.asmName).join(' '),
    as: [...units.map((u) => u.objName)].join(' '),
    ld: 'a.out',
  }
  return (
    <nav className="pipeline" aria-label={T.pipelineLabel}>
      <div className="pipe-src">
        <span className="pipe-art mono">{T.artifacts.src}</span>
        <span className="pipe-files mono">{st.files.map((f) => f.name).join(' ')}</span>
      </div>
      {STAGES.map((s) => {
        const state = stageState(b.stoppedAt, s)
        const Icon = state === 'ok' ? Check : state === 'error' ? X : CircleSlash
        return (
          <div className="pipe-step" key={s}>
            <ChevronRight className="pipe-arrow" size={18} aria-hidden />
            <button
              type="button"
              className={`pipe-stage is-${state}` + (st.stage === s ? ' is-active' : '')}
              aria-pressed={st.stage === s}
              onClick={() => st.setStage(s)}
              title={`${T.stages[s]}: ${T.stageState[state]}`}
            >
              <span className="pipe-name">
                <Icon size={14} aria-hidden /> {T.stages[s]}
              </span>
              <span className="pipe-art mono">
                {T.artifacts[s]}
                {state !== 'skipped' && artifacts[s] ? ` · ${artifacts[s]}` : ''}
              </span>
            </button>
          </div>
        )
      })}
      <button type="button" className="btn btn-primary pipe-run" disabled={!b.ld?.program} onClick={st.runInCpu} title={T.runInCpuTitle}>
        <Rocket size={16} aria-hidden />
        <span className="btn-label">{T.runInCpu}</span>
      </button>
    </nav>
  )
}

export function StepControls() {
  const T = t().tc
  const st = useToolchain()
  const n = stepCount(st.build, st.stage, st.pass, st.unit)
  const pos = st.pos ?? n
  return (
    <div className="tc-steps" role="toolbar" aria-label={t().ui.controlsLabel}>
      <button type="button" className="btn" onClick={st.reset} disabled={!n || pos === 0} title={`${T.controls.reset} (Shift+F5)`} aria-label={T.controls.reset}>
        <SkipBack size={16} aria-hidden />
      </button>
      <button type="button" className="btn" onClick={st.stepBack} disabled={!n || pos === 0} title={`${T.controls.back} (Shift+F10)`} aria-label={T.controls.back}>
        <StepBack size={16} aria-hidden />
      </button>
      <button type="button" className="btn btn-primary" onClick={st.step} disabled={!n} title={`${T.controls.step} (F10)`} aria-label={T.controls.step}>
        <StepForward size={16} aria-hidden />
        <span className="btn-label">{T.controls.step}</span>
      </button>
      <button type="button" className="btn" onClick={st.togglePlay} disabled={!n} title={`${st.playing ? T.controls.pause : T.controls.play} (F5)`} aria-label={st.playing ? T.controls.pause : T.controls.play}>
        {st.playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
      </button>
      <button type="button" className="btn" onClick={st.toEnd} disabled={!n || st.pos === null} title={T.controls.end} aria-label={T.controls.end}>
        <SkipForward size={16} aria-hidden />
      </button>
      <span className="tc-stepinfo mono" aria-live="polite">
        {n ? (st.pos === null ? `${T.stepOf(n, n)} · ${T.complete}` : T.stepOf(pos, n)) : ''}
      </span>
    </div>
  )
}

export function FileTabs({ readOnly }: { readOnly?: boolean }) {
  const T = t().tc.files
  const st = useToolchain()
  const [editing, setEditing] = useState<{ from: string | null; value: string; error?: string } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  const commit = () => {
    if (!editing) return
    const name = editing.value.trim()
    const err = editing.from === null ? st.addFile(name) : st.renameFile(editing.from, name)
    if (err) setEditing({ ...editing, error: err === 'exists' ? T.exists : T.invalidName })
    else setEditing(null)
  }

  return (
    <div className="file-tabs" role="tablist" aria-label={T.label}>
      {st.files.map((f) =>
        editing?.from === f.name ? (
          <NameInput key={f.name} editing={editing} setEditing={setEditing} commit={commit} />
        ) : (
          <div key={f.name} className={'file-tab' + (st.activeFile === f.name ? ' is-active' : '')}>
            <button type="button" role="tab" aria-selected={st.activeFile === f.name} className="file-tab-name mono" onClick={() => st.setActiveFile(f.name)} onDoubleClick={() => !readOnly && setEditing({ from: f.name, value: f.name })}>
              {f.name}
            </button>
            {!readOnly && st.activeFile === f.name && (
              <>
                <button type="button" className="file-tab-act" aria-label={`${T.rename} ${f.name}`} title={T.rename} onClick={() => setEditing({ from: f.name, value: f.name })}>
                  <Pencil size={12} aria-hidden />
                </button>
                {st.files.length > 1 &&
                  (confirm === f.name ? (
                    <button type="button" className="file-tab-act is-danger" onClick={() => { st.deleteFile(f.name); setConfirm(null) }} onBlur={() => setConfirm(null)}>
                      {T.confirmDelete}
                    </button>
                  ) : (
                    <button type="button" className="file-tab-act" aria-label={`${T.delete} ${f.name}`} title={T.delete} onClick={() => setConfirm(f.name)}>
                      <Trash2 size={12} aria-hidden />
                    </button>
                  ))}
              </>
            )}
          </div>
        ),
      )}
      {editing?.from === null && <NameInput editing={editing} setEditing={setEditing} commit={commit} />}
      {!readOnly && !editing && (
        <button type="button" className="file-tab-add" onClick={() => setEditing({ from: null, value: '' })} title={T.add} aria-label={T.add}>
          <FilePlus2 size={14} aria-hidden />
        </button>
      )}
      <span className="file-tabs-sep" aria-hidden />
      {Object.keys(SYSTEM_HEADERS).map((h) => (
        <button key={h} type="button" role="tab" aria-selected={st.activeFile === `<${h}>`} className={'file-tab sys mono' + (st.activeFile === `<${h}>` ? ' is-active' : '')} title={`${T.systemHeaders}`} onClick={() => st.setActiveFile(`<${h}>`)}>
          &lt;{h}&gt;
        </button>
      ))}
      {editing?.error && (
        <span className="file-tab-error" role="alert">
          {editing.error}
        </span>
      )}
    </div>
  )
}

function NameInput(props: { editing: { from: string | null; value: string; error?: string }; setEditing: (e: null | { from: string | null; value: string; error?: string }) => void; commit: () => void }) {
  return (
    <input
      className="file-tab-input mono"
      autoFocus
      value={props.editing.value}
      placeholder="util.c"
      aria-label={t().tc.files.add}
      aria-invalid={!!props.editing.error}
      onChange={(e) => props.setEditing({ ...props.editing, value: e.target.value, error: undefined })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') props.commit()
        if (e.key === 'Escape') props.setEditing(null)
      }}
      onBlur={() => (props.editing.value.trim() ? props.commit() : props.setEditing(null))}
    />
  )
}

export function ErrorList({ errors }: { errors: Diagnostic[] }) {
  if (!errors.length) return null
  return (
    <div className="error-list tc-errors" role="alert">
      <strong>{t().tc.errorsTitle}</strong>
      <ul>
        {errors.slice(0, 8).map((e, i) => (
          <li key={i}>{renderCode(formatDiag(e))}</li>
        ))}
      </ul>
    </div>
  )
}

export function Explain({ children }: { children: ReactNode }) {
  return (
    <section className="panel tc-explain" aria-label={t().tc.explanation}>
      <header className="panel-header">
        <h2>{t().tc.explanation}</h2>
      </header>
      <div className="explain tc-explain-body">{children}</div>
    </section>
  )
}

export function P({ text, className }: { text: string; className?: string }) {
  return <p className={className}>{renderCode(text)}</p>
}
