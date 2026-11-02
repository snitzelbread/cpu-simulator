/** Errors of all toolchain stages: a code plus parameters, formatted by the UI via i18n. */
export type Stage = 'pp' | 'cc' | 'as' | 'ld'

export interface Diagnostic {
  stage: Stage
  code: string
  params?: Record<string, string | number>
  /** Source file and 1-based line, when the error belongs to one. */
  file?: string
  line?: number
  col?: number
}

export class DiagnosticError extends Error {
  constructor(readonly diag: Diagnostic) {
    super(`${diag.stage}:${diag.code} ${diag.file ?? ''}:${diag.line ?? ''} ${JSON.stringify(diag.params ?? {})}`)
  }
}
