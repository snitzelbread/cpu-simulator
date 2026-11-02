/**
 * Preprocessor pass 1 (lecture model): join lines that end in a backslash and remove
 * comments. The number of lines stays the same: a joined line is followed by blank lines,
 * so later stages can still report the original line numbers.
 */
import type { Diagnostic } from '../diagnostics'

export interface Pass1Change {
  kind: 'splice' | 'lineComment' | 'blockComment'
  /** 1-based original line where the change starts / ends. */
  line: number
  endLine: number
  /** The removed text (comment) or the joined line pieces. */
  text: string
}

export interface Pass1Result {
  /** Output lines, same count as the input. */
  lines: string[]
  changes: Pass1Change[]
  /** For each output line: the original lines it was built from. */
  origin: number[][]
  errors: Diagnostic[]
}

export function pass1(file: string, source: string): Pass1Result {
  const input = source.replace(/\r\n?/g, '\n').split('\n')
  const changes: Pass1Change[] = []
  const errors: Diagnostic[] = []

  // Step 1: line splicing. Logical lines with their original line numbers per character.
  interface Logical { text: string; lineOf: number[]; first: number; last: number }
  const logical: Logical[] = []
  for (let i = 0; i < input.length; i++) {
    const first = i
    let text = ''
    const lineOf: number[] = []
    let cur = input[i]
    while (cur.endsWith('\\') && i + 1 < input.length) {
      const piece = cur.slice(0, -1)
      text += piece
      for (let k = 0; k < piece.length; k++) lineOf.push(i + 1)
      i++
      cur = input[i]
    }
    text += cur
    for (let k = 0; k < cur.length; k++) lineOf.push(i + 1)
    if (i > first) changes.push({ kind: 'splice', line: first + 1, endLine: i + 1, text: input.slice(first, i + 1).join('\n') })
    logical.push({ text, lineOf, first, last: i })
  }

  // Step 2: comments (outside string and character literals). A comment becomes one space.
  const out: string[] = new Array(input.length).fill('')
  const origin: number[][] = input.map(() => [])
  let inBlock: { start: number; text: string; outLine: number } | null = null
  for (const lg of logical) {
    let res = ''
    const s = lg.text
    let j = 0
    let outLine = lg.first
    if (inBlock) outLine = inBlock.outLine
    while (j < s.length) {
      if (inBlock) {
        const end = s.indexOf('*/', j)
        if (end < 0) {
          inBlock.text += s.slice(j) + '\n'
          j = s.length
          break
        }
        inBlock.text += s.slice(j, end + 2)
        changes.push({ kind: 'blockComment', line: inBlock.start, endLine: lg.lineOf[end] ?? lg.last + 1, text: inBlock.text })
        j = end + 2
        inBlock = null
        res += ' '
        continue
      }
      const c = s[j]
      if (c === '"' || c === "'") {
        let k = j + 1
        while (k < s.length && s[k] !== c) k += s[k] === '\\' ? 2 : 1
        res += s.slice(j, k + 1)
        j = k + 1
        continue
      }
      if (c === '/' && s[j + 1] === '/') {
        changes.push({ kind: 'lineComment', line: lg.lineOf[j], endLine: lg.last + 1, text: s.slice(j) })
        res += ' '
        j = s.length
        break
      }
      if (c === '/' && s[j + 1] === '*') {
        inBlock = { start: lg.lineOf[j], text: '/*', outLine }
        j += 2
        continue
      }
      res += c
      j++
    }
    // A block comment spanning several lines: its text is removed; the code after it continues
    // on the line where the comment started (so the line count stays the same).
    out[outLine] += res
    for (let k = lg.first; k <= lg.last; k++) if (!origin[outLine].includes(k + 1)) origin[outLine].push(k + 1)
  }
  if (inBlock) errors.push({ stage: 'pp', code: 'unterminatedComment', file, line: inBlock.start })
  return { lines: out.map((l) => l.replace(/\s+$/, '')), changes, origin, errors }
}
