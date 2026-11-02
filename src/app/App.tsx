import { Cpu, Moon, Sparkles, Sun } from 'lucide-react'
import { useEffect } from 'react'
import { EXAMPLES } from '../examples'
import { CpuView } from '../features/cpu/CpuView'
import { useCpu } from '../features/cpu/store'
import { ToolchainView } from '../features/toolchain/ToolchainView'
import { t } from '../i18n'
import { useSettings, type Mode, type NumberFormat } from './settings'

export function App() {
  const s = useSettings()
  const loadExample = useCpu((st) => st.loadExample)
  const C = t().controls

  useEffect(() => {
    document.documentElement.dataset.theme = s.theme
    document.documentElement.dataset.anim = s.animations ? 'on' : 'off'
  }, [s.theme, s.animations])

  const formats: NumberFormat[] = ['hex', 'udec', 'sdec', 'bin']
  const modes: Mode[] = ['cpu', 'toolchain']

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <Cpu size={20} aria-hidden />
          <h1>{t().appTitle}</h1>
        </div>
        <nav className="segmented mode-switch" aria-label={t().ui.modeNav}>
          {modes.map((m) => (
            <button key={m} type="button" aria-pressed={s.mode === m} className={s.mode === m ? 'is-active' : ''} onClick={() => s.set({ mode: m })}>
              {t().modes[m]}
            </button>
          ))}
        </nav>
        <div className="header-tools">
          {s.mode === 'cpu' && (
            <label className="select">
              <span className="visually-hidden">{C.examples}</span>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) loadExample(e.target.value)
                }}
              >
                <option value="">{C.chooseExample}</option>
                {EXAMPLES.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="segmented" role="radiogroup" aria-label={C.format}>
            {formats.map((f) => (
              <button key={f} type="button" role="radio" aria-checked={s.format === f} className={s.format === f ? 'is-active' : ''} onClick={() => s.set({ format: f })}>
                {t().formats[f]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={'icon-btn' + (s.animations ? ' is-active' : '')}
            aria-pressed={s.animations}
            onClick={() => s.set({ animations: !s.animations })}
            title={C.animations}
            aria-label={C.animations}
          >
            <Sparkles size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => s.set({ theme: s.theme === 'dark' ? 'light' : 'dark' })}
            title={`${C.theme}: ${s.theme === 'dark' ? C.themeDark : C.themeLight}`}
            aria-label={`${C.theme}: ${s.theme === 'dark' ? C.themeDark : C.themeLight}`}
          >
            {s.theme === 'dark' ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />}
          </button>
        </div>
      </header>
      {s.mode === 'cpu' ? <CpuView /> : <ToolchainView />}
    </div>
  )
}
