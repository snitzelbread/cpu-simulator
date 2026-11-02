import { AlertCircle, Binary } from 'lucide-react'
import { useSettings } from '../../app/settings'
import { formatError, t } from '../../i18n'
import { ConsolePanel } from './components/ConsolePanel'
import { Controls } from './components/Controls'
import { CpuPanel } from './components/CpuPanel'
import { renderCode } from './components/renderCode'
import { ExplanationPanel } from './components/ExplanationPanel'
import { MemoryView } from './components/MemoryView'
import { Panel } from './components/Panel'
import { StackView } from './components/StackView'
import { CodeEditor } from './editor/CodeEditor'
import { useShortcuts } from './shortcuts'
import { useCpu } from './store'
import { useView } from './view'

function CodePanel() {
  const errors = useCpu((s) => s.asm.errors)
  const running = useCpu((s) => s.running)
  const showBytes = useSettings((s) => s.showBytes)
  const setSettings = useSettings((s) => s.set)
  return (
    <Panel
      title={t().panels.code}
      area="code"
      className="code-panel"
      actions={
        <>
        <span className="panel-hint">{t().editor.breakpointHint}</span>
        <button
          type="button"
          className={'chip' + (showBytes ? ' is-active' : '')}
          aria-pressed={showBytes}
          onClick={() => setSettings({ showBytes: !showBytes })}
          title={t().ui.bytesTitle}
        >
          <Binary size={14} aria-hidden /> {t().ui.bytes}
        </button>
        </>
      }
    >
      <CodeEditor />
      {running && <div className="editor-locked">{t().editor.lockedHint}</div>}
      {errors.length > 0 && (
        <div className="error-list" role="alert">
          <strong>
            <AlertCircle size={14} aria-hidden /> {t().errorsTitle}
          </strong>
          <ul>
            {errors.slice(0, 6).map((e, i) => (
              <li key={i}>{renderCode(t().editor.lineError(e.line, formatError(e)))}</li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

export function CpuView() {
  useShortcuts(true)
  const view = useView()
  return (
    <div className="cpu-view">
      <Controls />
      <main className="cpu-grid">
        <CodePanel />
        <CpuPanel view={view} />
        <StackView view={view} />
        <MemoryView view={view} />
        <ExplanationPanel view={view} />
        <ConsolePanel view={view} />
      </main>
    </div>
  )
}
