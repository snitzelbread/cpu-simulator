import { useEffect } from 'react'
import { t } from '../../i18n'
import { isSourceFile } from '../../toolchain/project'
import { PipelineBar, StepControls } from './components/common'
import { AssemblerStage } from './stages/AssemblerStage'
import { CompilerStage } from './stages/CompilerStage'
import { LinkerStage } from './stages/LinkerStage'
import { PreprocessorStage } from './stages/PreprocessorStage'
import { useToolchain } from './store'

/** Same keys as the CPU view: F10 step, Shift+F10 back, F5 play/pause, Shift+F5 to the start. */
function useToolchainShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useToolchain.getState()
      if (e.key === 'F10' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        if (e.shiftKey) st.stepBack()
        else st.step()
      } else if (e.key === 'F5') {
        e.preventDefault() // never reload the page
        if (e.shiftKey) st.reset()
        else st.togglePlay()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])
}

export function ToolchainView() {
  useToolchainShortcuts()
  const T = t().tc
  const st = useToolchain()
  const units = st.files.filter((f) => isSourceFile(f.name))
  return (
    <div className="tc-view">
      <PipelineBar />
      <div className="tc-toolbar">
        <StepControls />
        {st.stage !== 'ld' && units.length > 1 && (
          <label className="select tc-unit" title={T.unitTitle}>
            <span>{T.unit}</span>
            <select value={st.unit} onChange={(e) => st.setUnit(e.target.value)}>
              {units.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {st.build.stoppedAt && (
          <span className="tc-stopped" role="status">
            {T.stoppedAt(T.stages[st.build.stoppedAt], st.build.errors.length)}
          </span>
        )}
      </div>
      <main className="tc-main">
        {st.stage === 'pp' ? <PreprocessorStage /> : st.stage === 'cc' ? <CompilerStage /> : st.stage === 'as' ? <AssemblerStage /> : <LinkerStage />}
      </main>
    </div>
  )
}
