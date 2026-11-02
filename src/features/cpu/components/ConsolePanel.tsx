import { useEffect, useRef } from 'react'
import { t } from '../../../i18n'
import type { View } from '../view'
import { Panel } from './Panel'

export function ConsolePanel({ view }: { view: View }) {
  const C = t().console
  const ref = useRef<HTMLPreElement>(null)
  const m = view.machine
  const entries = m?.console ?? []
  const decoder = new TextDecoder()
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [view.version])
  return (
    <Panel title={t().panels.console} area="console">
      <pre className="console" ref={ref} aria-live="polite" aria-label={t().panels.console}>
        {entries.length === 0 && m?.status !== 'exited' && <span className="console-empty">{C.empty}</span>}
        {entries.map((e, i) => (
          <span key={i} className={e.fd === 2 ? 'console-err' : ''} title={e.fd === 2 ? C.stderr : undefined}>
            {decoder.decode(new Uint8Array(e.bytes))}
          </span>
        ))}
        {m?.status === 'exited' && <span className="console-exit">{'\n'}{C.exit(m.exitCode ?? 0)}</span>}
      </pre>
    </Panel>
  )
}
