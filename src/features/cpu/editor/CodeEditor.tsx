import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorState, RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, gutter, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { useSettings } from '../../../app/settings'
import { formatError, t } from '../../../i18n'
import { hexByte } from '../format'
import { useCpu } from '../store'
import { nasmHighlight, nasmLanguage } from './nasm'

// ---------------------------------------------------------------- breakpoints

class BreakpointMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-bp-dot'
    el.setAttribute('aria-label', t().ui.breakpoint)
    return el
  }
}
const bpMarker = new BreakpointMarker()
const toggleBp = StateEffect.define<number>() // document position

const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(toggleBp)) continue
      let has = false
      set.between(e.value, e.value, () => {
        has = true
      })
      set = has ? set.update({ filter: (from) => from !== e.value }) : set.update({ add: [bpMarker.range(e.value)] })
    }
    return set
  },
})

function bpLines(state: EditorState): number[] {
  const lines: number[] = []
  state.field(breakpointField).between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number)
  })
  return lines
}

// ---------------------------------------------------------------- execution line + errors + addresses

interface LineInfo {
  exec: number | null
  /** micro-phase fetch/decode marker style */
  execKind: 'next' | 'fetch' | 'done'
  errors: Map<number, string>
  addresses: Map<number, { addr: number; bytes?: number[] }>
}
const setInfo = StateEffect.define<LineInfo>()
const infoField = StateField.define<LineInfo>({
  create: () => ({ exec: null, execKind: 'next', errors: new Map(), addresses: new Map() }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setInfo)) return e.value
    return v
  },
})

const lineDecorations = EditorView.decorations.compute(['doc', infoField], (state): DecorationSet => {
  const info = state.field(infoField)
  const decos = []
  const lines = new Set<number>([...info.errors.keys()])
  if (info.exec) lines.add(info.exec)
  for (const n of [...lines].sort((a, b) => a - b)) {
    if (n > state.doc.lines) continue
    const cls = [n === info.exec ? `cm-exec cm-exec-${info.execKind}` : '', info.errors.has(n) ? 'cm-error-line' : ''].join(' ').trim()
    decos.push(Decoration.line({ class: cls }).range(state.doc.line(n).from))
  }
  return Decoration.set(decos)
})

class TextMarker extends GutterMarker {
  constructor(
    private text: string,
    private cls: string,
    private title?: string,
  ) {
    super()
  }
  eq(o: TextMarker) {
    return o.text === this.text && o.cls === this.cls && o.title === this.title
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = this.cls
    el.textContent = this.text
    if (this.title) el.title = this.title
    return el
  }
}

const bpGutter = gutter({
  class: 'cm-bp-gutter',
  markers: (v) => v.state.field(breakpointField),
  lineMarker(view, line) {
    const info = view.state.field(infoField)
    const n = view.state.doc.lineAt(line.from).number
    if (info.errors.has(n)) return new TextMarker('!', 'cm-err-mark', info.errors.get(n))
    if (info.exec === n) return new TextMarker('▶', 'cm-exec-arrow')
    return null
  },
  lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setInfo))),
  initialSpacer: () => new TextMarker('▶', 'cm-exec-arrow'),
  domEventHandlers: {
    mousedown(view, line) {
      view.dispatch({ effects: toggleBp.of(line.from) })
      return true
    },
  },
})

function addrGutter(showBytes: boolean): Extension {
  const g = gutter({
    class: 'cm-addr-gutter',
    lineMarker(view, line) {
      const info = view.state.field(infoField)
      const n = view.state.doc.lineAt(line.from).number
      const a = info.addresses.get(n)
      if (!a) return null
      return new TextMarker(a.addr.toString(16).toUpperCase().padStart(6, '0'), 'cm-addr')
    },
    lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setInfo))),
    initialSpacer: () => new TextMarker('000000', 'cm-addr'),
  })
  if (!showBytes) return g
  const b = gutter({
    class: 'cm-bytes-gutter',
    lineMarker(view, line) {
      const info = view.state.field(infoField)
      const a = info.addresses.get(view.state.doc.lineAt(line.from).number)
      if (!a?.bytes) return null
      const hex = a.bytes.map(hexByte).join(' ')
      const short = a.bytes.length > 7 ? a.bytes.slice(0, 6).map(hexByte).join(' ') + ' …' : hex
      return new TextMarker(short, 'cm-bytes', hex)
    },
    lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setInfo))),
    initialSpacer: () => new TextMarker('00 00 00 00 00 00 …', 'cm-bytes'),
  })
  return [g, b]
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--fg-faint)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
})

// ---------------------------------------------------------------- component

export function CodeEditor() {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const readOnly = useRef(new Compartment())
  const bytesComp = useRef(new Compartment())
  const source = useCpu((s) => s.source)
  const asm = useCpu((s) => s.asm)
  const machine = useCpu((s) => s.machine)
  const version = useCpu((s) => s.version)
  const running = useCpu((s) => s.running)
  const phase = useCpu((s) => s.microPhase)
  const showBytes = useSettings((s) => s.showBytes)

  // create the editor once
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: useCpu.getState().source,
        extensions: [
          infoField,
          breakpointField,
          bpGutter,
          lineNumbers(),
          bytesComp.current.of(addrGutter(useSettings.getState().showBytes)),
          lineDecorations,
          history(),
          keymap.of([
            {
              // F9: toggle a breakpoint on the cursor line (keyboard alternative to the gutter click)
              key: 'F9',
              preventDefault: true,
              run: (v) => {
                v.dispatch({ effects: toggleBp.of(v.state.doc.lineAt(v.state.selection.main.head).from) })
                return true
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          nasmLanguage,
          nasmHighlight,
          editorTheme,
          readOnly.current.of(EditorState.readOnly.of(false)),
          EditorView.contentAttributes.of({ 'aria-label': t().panels.code, spellcheck: 'false' }),
          EditorView.updateListener.of((u) => {
            const st = useCpu.getState()
            if (u.docChanged) st.setSource(u.state.doc.toString())
            if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(toggleBp)))) {
              st.setBreakpoints(bpLines(u.state))
            }
            if (u.selectionSet) st.setCursorLine(u.state.doc.lineAt(u.state.selection.main.head).number)
          }),
        ],
      }),
    })
    viewRef.current = view
    // re-create breakpoint markers kept in the store (e.g. after switching modes)
    const lines = useCpu.getState().breakpoints.filter((l) => l <= view.state.doc.lines)
    if (lines.length) view.dispatch({ effects: lines.map((l) => toggleBp.of(view.state.doc.line(l).from)) })
    return () => view.destroy()
  }, [])

  // external source changes (example loaded)
  useEffect(() => {
    const view = viewRef.current!
    if (view.state.doc.toString() !== source) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } })
      // a new program: clear breakpoints
      const lines = bpLines(view.state)
      for (const l of lines) view.dispatch({ effects: toggleBp.of(view.state.doc.line(l).from) })
    }
  }, [source])

  useEffect(() => {
    viewRef.current!.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(running)) })
  }, [running])

  useEffect(() => {
    viewRef.current!.dispatch({ effects: bytesComp.current.reconfigure(addrGutter(showBytes)) })
  }, [showBytes])

  // execution marker, errors, addresses
  useEffect(() => {
    const view = viewRef.current!
    const errors = new Map<number, string>()
    for (const e of asm.errors) if (!errors.has(e.line)) errors.set(e.line, formatError(e))
    const addresses = new Map<number, { addr: number; bytes?: number[] }>()
    for (const [line, addr] of asm.sourceMap.lineToAddress) addresses.set(line, { addr })
    if (asm.program) for (const ins of asm.program.instructions) addresses.set(ins.line, { addr: ins.address, bytes: ins.bytes })
    let exec: number | null = null
    let execKind: LineInfo['execKind'] = 'next'
    if (machine) {
      const last = machine.history.at(-1)
      if (((phase === 2 || phase === 3) || machine.done) && last) {
        exec = last.instr.line
        execKind = 'done'
      } else {
        const cur = machine.current
        exec = cur?.line ?? null
        if (phase === 0 || phase === 1) execKind = 'fetch'
      }
    }
    view.dispatch({ effects: setInfo.of({ exec, execKind, errors, addresses }) })
    if (exec && exec <= view.state.doc.lines) {
      const pos = view.state.doc.line(exec).from
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: 48 }) })
    }
  }, [asm, machine, version, phase])

  return <div className="code-editor" ref={host} />
}
