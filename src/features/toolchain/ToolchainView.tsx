import { Wrench } from 'lucide-react'
import { t } from '../../i18n'

/** Placeholder for the planned C → assembly toolchain mode. */
export function ToolchainView() {
  return (
    <main className="toolchain-placeholder">
      <Wrench size={32} aria-hidden />
      <h2>{t().modes.toolchain}</h2>
      <p>{t().toolchainSoon}</p>
    </main>
  )
}
