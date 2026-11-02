import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { t } from '../../../i18n'
import { astTree, type AstNode, type StmtInfo } from '../../../toolchain/cc'
import { Panel } from '../../cpu/components/Panel'
import { CodeView } from '../components/CodeView'
import { ErrorList, Explain, FileTabs, P } from '../components/common'
import { activeText } from '../components/util'
import { currentIndex, unitOf } from '../steps'
import { useToolchain } from '../store'

const COLORS = 8

type Tab = 'asm' | 'ast' | 'vars'

export function CompilerStage() {
  const T = t().tc.cc
  const st = useToolchain()
  const u = unitOf(st.build, st.unit)
  const cc = u?.cc && !u.cc.errors.length ? u.cc : null
  const active = activeText(st.files, st.activeFile)
  const [tab, setTab] = useState<Tab>('asm')

  // statement colours, the visible assembly (step mode) and the C ↔ asm mapping
  const m = useMemo(() => {
    if (!cc) return null
    const color = new Map<number, number>()
    cc.stmts.forEach((s, i) => color.set(s.id, i % COLORS))
    const byId = new Map(cc.stmts.map((s) => [s.id, s]))
    const steps = cc.steps
    const cur = currentIndex(st.pos, steps.length)
    const counts = st.pos === null ? null : cur >= 0 ? steps[cur].counts : { header: 0, text: 0, data: 0, bss: 0 }
    const seen: Record<string, number> = { header: 0, text: 0, data: 0, bss: 0 }
    const visible: number[] = [] // indexes into cc.lines
    cc.lines.forEach((l, i) => {
      const k = seen[l.section]++
      if (!counts || k < counts[l.section]) visible.push(i)
    })
    return { color, byId, visible, current: st.pos !== null && cur >= 0 ? steps[cur].stmt : undefined }
  }, [cc, st.pos])

  const focus = st.pinned ?? st.hover
  // which statements are focused (via a C line or an asm line)
  const focusStmts = useMemo(() => {
    const out = new Set<number>()
    if (!cc || !m || !focus) return out
    if (focus.kind === 'c') for (const s of cc.stmts) if (s.loc.file === focus.file && s.loc.line === focus.line) out.add(s.id)
    if (focus.kind === 'asm') {
      const l = cc.lines[m.visible[focus.line - 1]]
      if (l?.stmt !== undefined) out.add(l.stmt)
    }
    return out
  }, [cc, m, focus])

  const cClasses = useMemo(() => {
    const map = new Map<number, string>()
    if (!cc || !m) return map
    for (const s of cc.stmts) {
      if (s.loc.file !== st.activeFile) continue
      const cls = [`tc-c${m.color.get(s.id)}`]
      if (focusStmts.has(s.id)) cls.push('tc-hl')
      if (m.current === s.id) cls.push('tc-current')
      if (!map.has(s.loc.line) || focusStmts.has(s.id) || m.current === s.id) map.set(s.loc.line, cls.join(' '))
    }
    return map
  }, [cc, m, focusStmts, st.activeFile])

  const asm = useMemo(() => {
    const classes = new Map<number, string>()
    if (!cc || !m) return { doc: '', classes, scroll: null as number | null }
    let scroll: number | null = null
    m.visible.forEach((idx, i) => {
      const l = cc.lines[idx]
      if (l.stmt === undefined) return
      const cls = [`tc-c${m.color.get(l.stmt)}`]
      if (focusStmts.has(l.stmt)) {
        cls.push('tc-hl')
        if (scroll === null && st.hover?.kind === 'c') scroll = i + 1
      }
      if (m.current === l.stmt) {
        cls.push('tc-current')
        scroll = i + 1
      }
      classes.set(i + 1, cls.join(' '))
    })
    if (st.pos !== null && m.current === undefined) scroll = m.visible.length
    return { doc: m.visible.map((i) => cc.lines[i].text).join('\n'), classes, scroll }
  }, [cc, m, focusStmts, st.hover, st.pos])

  const focusStmt: StmtInfo | undefined = cc && m ? (m.current !== undefined ? m.byId.get(m.current) : [...focusStmts].map((id) => m.byId.get(id)).find(Boolean)) : undefined

  return (
    <>
      <div className="tc-stage">
        <Panel title={T.input} area="in" className="tc-in" actions={<span className="panel-hint">{T.hoverHint}</span>}>
          <FileTabs />
          <CodeView
            doc={active.text}
            language="c"
            editable={!active.readOnly}
            onChange={(txt) => st.setText(st.activeFile, txt)}
            lineClasses={cClasses}
            onHoverLine={(line) => st.setHover(line ? { kind: 'c', file: st.activeFile, line } : null)}
            onClickLine={(line) => st.setPinned({ kind: 'c', file: st.activeFile, line })}
            scrollTo={focusStmt && focusStmt.loc.file === st.activeFile && st.hover?.kind !== 'c' ? focusStmt.loc.line : null}
            label={T.input}
          />
        </Panel>
        <Panel
          title={`${T.output} · ${u?.asmName ?? ''}`}
          area="out"
          className="tc-out"
          actions={
            <div className="segmented" role="tablist">
              {(['asm', 'ast', 'vars'] as Tab[]).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)} title={k === 'ast' ? T.astTitle : k === 'vars' ? T.varsTitle : undefined}>
                  {k === 'asm' ? T.output : k === 'ast' ? T.ast : T.vars}
                </button>
              ))}
            </div>
          }
        >
          {!cc ? (
            st.build.stoppedAt === 'pp' ? <p className="empty">{t().tc.notReached(t().tc.stages.cc)}</p> : null
          ) : tab === 'asm' ? (
            <CodeView
              doc={asm.doc}
              language="nasm"
              lineClasses={asm.classes}
              onHoverLine={(line) => st.setHover(line ? { kind: 'asm', line } : null)}
              onClickLine={(line) => st.setPinned({ kind: 'asm', line })}
              scrollTo={asm.scroll}
              label={T.output}
            />
          ) : tab === 'ast' ? (
            <AstView stmt={focusStmt} />
          ) : (
            <VarsView />
          )}
          <ErrorList errors={u?.cc?.errors.length ? u.cc.errors : st.build.stoppedAt === 'pp' ? st.build.errors : []} />
        </Panel>
      </div>
      <Explain>
        {focusStmt ? (
          <>
            <P className="summary" text={`\`${focusStmt.src}\`  (${focusStmt.loc.file}:${focusStmt.loc.line}) — ${T.construct[focusStmt.construct] ?? ''}`} />
            {focusStmt.notes.length > 0 && (
              <ul className="notes">
                {focusStmt.notes.map((n) => (
                  <li key={n}>
                    <P text={T.note[n]} />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <P className="summary" text={T.hoverHint} />
        )}
        <P className="muted" text={T.typesVanish} />
        <P className="muted small" text={t().tc.realCompilers} />
      </Explain>
    </>
  )
}

function AstView({ stmt }: { stmt?: StmtInfo }) {
  const T = t().tc.cc
  const st = useToolchain()
  const u = unitOf(st.build, st.unit)
  const unit = u?.cc?.unit
  const funcs = unit?.items.filter((i) => i.k === 'func').map((i) => (i as Extract<typeof i, { k: 'func' }>).def) ?? []
  const fname = stmt?.func
  const def = funcs.find((f) => f.sym.name === fname) ?? funcs[0]
  if (!def) return <p className="empty">{T.noFunction}</p>
  return (
    <div className="ast-view">
      <div className="ast-funcs segmented">
        {funcs.map((f) => (
          <span key={f.sym.name} className={'mono' + (f === def ? ' is-active' : '')}>
            {f.sym.name}
          </span>
        ))}
      </div>
      <ul className="ast-tree" role="tree">
        <AstItem node={astTree(def)} depth={0} />
      </ul>
    </div>
  )
}

function AstItem({ node, depth }: { node: AstNode; depth: number }) {
  const [open, setOpen] = useState(depth < 3)
  const st = useToolchain()
  const has = node.children.length > 0
  return (
    <li role="treeitem" aria-expanded={has ? open : undefined}>
      <button
        type="button"
        className="ast-node"
        onClick={() => setOpen(!open)}
        onMouseEnter={() => st.setHover({ kind: 'c', file: node.loc.file, line: node.loc.line })}
        onMouseLeave={() => st.setHover(null)}
      >
        {has ? open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden /> : <span className="ast-leaf" aria-hidden />}
        <span className="mono">{node.label}</span>
        {node.type && <span className="ast-type mono">{node.type}</span>}
        <span className="ast-loc">:{node.loc.line}</span>
      </button>
      {has && open && (
        <ul role="group">
          {node.children.map((c, i) => (
            <AstItem key={i} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

function VarsView() {
  const T = t().tc.cc
  const st = useToolchain()
  const cc = unitOf(st.build, st.unit)?.cc
  if (!cc) return null
  const rows = [
    ...cc.globals.map((g) => ({ ...g, scope: '' })),
    ...cc.functions.flatMap((f) => f.vars.map((v) => ({ ...v, scope: f.name }))),
  ]
  return (
    <div className="table-wrap">
      <table className="tc-table">
        <thead>
          <tr>
            <th>{T.vars}</th>
            <th>C</th>
            <th>size</th>
            <th>where</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onMouseEnter={() => st.setHover({ kind: 'c', file: r.loc.file, line: r.loc.line })} onMouseLeave={() => st.setHover(null)}>
              <td className="mono">{r.scope ? `${r.scope}: ${r.name}` : r.name}</td>
              <td className="mono">{r.type}</td>
              <td>{T.bytes(r.size)}</td>
              <td className="mono">{r.where}</td>
              <td className="muted">{T.varKind[r.kind]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
