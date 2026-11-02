import { cpp } from '@codemirror/lang-cpp'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, gutter, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { nasmHighlight, nasmLanguage } from '../../cpu/editor/nasm'

export interface Mark {
  line: number
  /** 0-based column range inside the line. */
  from: number
  to: number
  cls: string
}

export interface CodeViewProps {
  doc: string
  language: 'c' | 'nasm' | 'plain'
  editable?: boolean
  onChange?: (text: string) => void
  lineClasses?: Map<number, string>
  marks?: Mark[]
  /** Text shown in an extra gutter left of the code (e.g. offsets, origin file). */
  gutterText?: Map<number, string>
  gutterTitle?: Map<number, string>
  showLineNumbers?: boolean
  onHoverLine?: (line: number | null) => void
  onClickLine?: (line: number) => void
  scrollTo?: number | null
  label: string
}

interface Deco {
  lines: Map<number, string>
  marks: Mark[]
  gutter: Map<number, string>
  titles: Map<number, string>
}
const setDeco = StateEffect.define<Deco>()
const decoField = StateField.define<Deco>({
  create: () => ({ lines: new Map(), marks: [], gutter: new Map(), titles: new Map() }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setDeco)) return e.value
    return v
  },
})

const decorations = EditorView.decorations.compute(['doc', decoField], (state): DecorationSet => {
  const d = state.field(decoField)
  const ranges = []
  const n = state.doc.lines
  for (const [line, cls] of d.lines) if (line >= 1 && line <= n && cls) ranges.push(Decoration.line({ class: cls }).range(state.doc.line(line).from))
  for (const m of d.marks) {
    if (m.line < 1 || m.line > n) continue
    const l = state.doc.line(m.line)
    const from = l.from + Math.min(m.from, l.length)
    const to = l.from + Math.min(m.to, l.length)
    if (to > from) ranges.push(Decoration.mark({ class: m.cls }).range(from, to))
  }
  return Decoration.set(ranges, true)
})

class TextMarker extends GutterMarker {
  constructor(
    readonly text: string,
    readonly title?: string,
  ) {
    super()
  }
  eq(o: TextMarker) {
    return o.text === this.text && o.title === this.title
  }
  toDOM() {
    const el = document.createElement('span')
    el.textContent = this.text
    if (this.title) el.title = this.title
    return el
  }
}

function textGutter(): Extension {
  return gutter({
    class: 'cm-tc-gutter',
    lineMarker(view, line) {
      const d = view.state.field(decoField)
      const n = view.state.doc.lineAt(line.from).number
      const t = d.gutter.get(n)
      return t ? new TextMarker(t, d.titles.get(n)) : null
    },
    lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setDeco))),
  })
}

const cHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.keyword, tags.controlKeyword, tags.modifier], color: 'var(--syn-mnemonic)' },
    { tag: [tags.typeName, tags.standard(tags.typeName)], color: 'var(--syn-register)' },
    { tag: [tags.number, tags.bool], color: 'var(--syn-number)' },
    { tag: [tags.string, tags.character], color: 'var(--syn-string)' },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
    { tag: [tags.processingInstruction, tags.macroName, tags.meta], color: 'var(--syn-directive)' },
    { tag: [tags.function(tags.variableName), tags.function(tags.definition(tags.variableName))], color: 'var(--syn-label)' },
  ]),
)

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--fg-faint)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
})

function lang(l: CodeViewProps['language']): Extension {
  if (l === 'c') return [cpp(), cHighlight]
  if (l === 'nasm') return [nasmLanguage, nasmHighlight]
  return []
}

export function CodeView(props: CodeViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const comp = useRef({ lang: new Compartment(), edit: new Compartment(), ln: new Compartment() })
  const cb = useRef(props)
  cb.current = props

  // the extensions, built from the current props (also used when a new document replaces the old one)
  const makeState = (doc: string) => {
    const c = comp.current
    const p = cb.current
    return EditorState.create({
      doc,
      extensions: [
        decoField,
        c.ln.of(p.showLineNumbers === false ? [] : lineNumbers()),
        textGutter(),
        decorations,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        c.lang.of(lang(p.language)),
        c.edit.of([EditorState.readOnly.of(!p.editable), EditorView.editable.of(!!p.editable)]),
        theme,
        EditorView.contentAttributes.of({ 'aria-label': p.label, spellcheck: 'false' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && cb.current.editable) cb.current.onChange?.(u.state.doc.toString())
        }),
        EditorView.domEventHandlers({
          mousemove(e, v) {
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
            cb.current.onHoverLine?.(pos === null ? null : v.state.doc.lineAt(pos).number)
          },
          mouseleave() {
            cb.current.onHoverLine?.(null)
          },
          click(e, v) {
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
            if (pos !== null) cb.current.onClickLine?.(v.state.doc.lineAt(pos).number)
          },
        }),
      ],
    })
  }

  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: makeState(props.doc) })
    viewRef.current = view
    return () => view.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = viewRef.current!
    if (v.state.doc.toString() === props.doc) return
    // a different document (other file, example, new build): fresh state, so undo cannot reach the old text
    v.setState(makeState(props.doc))
    v.dispatch({
      effects: setDeco.of({ lines: props.lineClasses ?? new Map(), marks: props.marks ?? [], gutter: props.gutterText ?? new Map(), titles: props.gutterTitle ?? new Map() }),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.doc])

  useEffect(() => {
    viewRef.current!.dispatch({ effects: comp.current.lang.reconfigure(lang(props.language)) })
  }, [props.language])

  useEffect(() => {
    viewRef.current!.dispatch({
      effects: comp.current.edit.reconfigure([EditorState.readOnly.of(!props.editable), EditorView.editable.of(!!props.editable)]),
    })
  }, [props.editable])

  useEffect(() => {
    viewRef.current!.dispatch({
      effects: setDeco.of({ lines: props.lineClasses ?? new Map(), marks: props.marks ?? [], gutter: props.gutterText ?? new Map(), titles: props.gutterTitle ?? new Map() }),
    })
  }, [props.lineClasses, props.marks, props.gutterText, props.gutterTitle, props.doc])

  useEffect(() => {
    const v = viewRef.current!
    const l = props.scrollTo
    if (l && l >= 1 && l <= v.state.doc.lines) v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(l).from, { y: 'nearest', yMargin: 40 }) })
  }, [props.scrollTo, props.doc])

  return <div className="code-editor tc-code" ref={host} />
}
