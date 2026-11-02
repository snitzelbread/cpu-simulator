import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { allMnemonics } from '../../../core/isa'
import { lookupRegister } from '../../../core/registers'

const MNEMONICS = new Set(allMnemonics())
const DIRECTIVES = new Set([
  'section', 'segment', 'global', 'bits', 'default', 'db', 'dw', 'dd', 'dq', 'resb', 'resw', 'resd', 'resq',
  'equ', 'times', 'rel', 'abs', 'extern',
])
const SIZES = new Set(['byte', 'word', 'dword', 'qword'])

/** NASM syntax highlighting (token level). */
export const nasmLanguage = StreamLanguage.define<null>({
  name: 'nasm',
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) return null
    if (stream.peek() === ';') {
      stream.skipToEnd()
      return 'comment'
    }
    const q = stream.peek()
    if (q === "'" || q === '"' || q === '`') {
      stream.next()
      let esc = false
      let c: string | void
      while ((c = stream.next()) !== undefined) {
        if (c === q && !esc) break
        esc = q === '`' && c === '\\' && !esc
      }
      return 'string'
    }
    if (stream.match(/^(0[xX][0-9a-fA-F_]+|0[bByY][01_]+|0[oOqQ][0-7_]+|[0-9][0-9a-fA-F_]*[hHxX]\b|[0-9][0-9_]*[bByYqQoOdDtT]?\b)/)) return 'number'
    const word = stream.match(/^[A-Za-z_.?@][\w.?@$#~]*/) as RegExpMatchArray | null
    if (word) {
      const w = word[0].toLowerCase()
      if (stream.peek() === ':') return 'labelName'
      if (MNEMONICS.has(w)) return 'keyword'
      if (lookupRegister(w)) return 'variableName.special'
      if (DIRECTIVES.has(w)) return 'meta'
      if (SIZES.has(w)) return 'typeName'
      return 'variableName'
    }
    if (stream.match('$$') || stream.match('$')) return 'atom'
    stream.next()
    return 'punctuation'
  },
  languageData: { commentTokens: { line: ';' } },
})

export const nasmHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
    { tag: tags.keyword, color: 'var(--syn-mnemonic)', fontWeight: '600' },
    { tag: tags.special(tags.variableName), color: 'var(--syn-register)' },
    { tag: tags.number, color: 'var(--syn-number)' },
    { tag: tags.string, color: 'var(--syn-string)' },
    { tag: tags.meta, color: 'var(--syn-directive)' },
    { tag: tags.typeName, color: 'var(--syn-size)' },
    { tag: tags.labelName, color: 'var(--syn-label)', fontWeight: '600' },
    { tag: tags.atom, color: 'var(--syn-number)' },
    { tag: tags.variableName, color: 'var(--syn-symbol)' },
    { tag: tags.punctuation, color: 'var(--fg-muted)' },
  ]),
)
