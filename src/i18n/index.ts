import { en, type Strings } from './en'

export type { Strings }

/** Registered languages. Add e.g. `de` here once src/i18n/de.ts exists. */
export const languages = { en } satisfies Record<string, Strings>
export type Language = keyof typeof languages

let current: Strings = en

export function setLanguage(lang: Language) {
  current = languages[lang]
}

/** The active string table. */
export function t(): Strings {
  return current
}

export function formatError(e: { code: keyof Strings['errors']; params?: Record<string, string | number> }): string {
  return current.errors[e.code](e.params ?? {})
}

export function formatFault(f: { code: keyof Strings['faults']; params?: Record<string, string | number> }): string {
  return current.faults[f.code](f.params ?? {})
}

/** A toolchain diagnostic as "file:line: message". */
export function formatDiag(d: { stage: string; code: string; params?: Record<string, string | number>; file?: string; line?: number }): string {
  const m = d.stage === 'as' && d.code in current.errors ? current.errors[d.code as keyof Strings['errors']](d.params ?? {}) : (current.tc.errors[d.code]?.(d.params ?? {}) ?? d.code)
  return current.tc.diag(d.file, d.line, m)
}
