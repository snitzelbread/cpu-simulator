import { SYSTEM_HEADERS } from '../../../toolchain/project'
import type { StageId } from '../store'

export const STAGES: StageId[] = ['pp', 'cc', 'as', 'ld']

export function stageState(stoppedAt: StageId | null, s: StageId): 'ok' | 'error' | 'skipped' {
  if (!stoppedAt) return 'ok'
  const a = STAGES.indexOf(stoppedAt)
  const b = STAGES.indexOf(s)
  return b < a ? 'ok' : b === a ? 'error' : 'skipped'
}

/** The source text of the active file (project file or built-in system header). */
export function activeText(files: { name: string; text: string }[], active: string): { text: string; readOnly: boolean } {
  const m = /^<(.+)>$/.exec(active)
  if (m) return { text: SYSTEM_HEADERS[m[1]] ?? '', readOnly: true }
  return { text: files.find((f) => f.name === active)?.text ?? '', readOnly: false }
}
