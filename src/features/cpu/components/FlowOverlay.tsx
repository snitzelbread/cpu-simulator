import { useLayoutEffect, useState, type RefObject } from 'react'
import type { Flow } from './flows'

interface Path {
  d: string
  kind: Flow['kind']
  stage: number
  len: number
}

function anchor(r: DOMRect, toward: DOMRect, base: DOMRect, id: string): [number, number] {
  // registers connect on their right edge (towards the ALU / bus side of the die)
  if (id.startsWith('reg-')) return [r.right - base.left, r.top + r.height / 2 - base.top]
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const tx = toward.left + toward.width / 2
  const ty = toward.top + toward.height / 2
  let x = cx
  let y = cy
  if (Math.abs(tx - cx) > Math.abs(ty - cy) * 0.6) x = tx > cx ? r.right : r.left
  else y = ty > cy ? r.bottom : r.top
  return [x - base.left, y - base.top]
}

/** SVG layer that draws the data paths of the last step between elements marked with data-flow. */
export function FlowOverlay({ container, flows, version, animate }: { container: RefObject<HTMLElement | null>; flows: Flow[]; version: number; animate: boolean }) {
  const [paths, setPaths] = useState<Path[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const el = container.current
    if (!el) return
    const measure = () => {
      const base = el.getBoundingClientRect()
      const find = (id: string) => el.querySelector<HTMLElement>(`[data-flow="${id}"]`)?.getBoundingClientRect()
      const out: Path[] = []
      for (const f of flows) {
        const a = find(f.from)
        const b = find(f.to)
        if (!a || !b) continue
        const [x1, y1] = anchor(a, b, base, f.from)
        const [x2, y2] = anchor(b, a, base, f.to)
        const bothRegs = f.from.startsWith('reg-') && f.to.startsWith('reg-')
        const horizontal = Math.abs(x2 - x1) > Math.abs(y2 - y1) || bothRegs
        const c = horizontal ? Math.max(30, Math.abs(x2 - x1) / 2) : Math.max(24, Math.abs(y2 - y1) / 2)
        const d = bothRegs
          ? `M${x1},${y1} C${x1 + 60},${y1} ${x2 + 60},${y2} ${x2},${y2}`
          : horizontal
          ? `M${x1},${y1} C${x1 + Math.sign(x2 - x1) * c},${y1} ${x2 - Math.sign(x2 - x1) * c},${y2} ${x2},${y2}`
          : `M${x1},${y1} C${x1},${y1 + Math.sign(y2 - y1) * c} ${x2},${y2 - Math.sign(y2 - y1) * c} ${x2},${y2}`
        out.push({ d, kind: f.kind, stage: f.stage, len: Math.hypot(x2 - x1, y2 - y1) * 1.4 + 40 })
      }
      setPaths(out)
      setSize({ w: base.width, h: base.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [container, flows, version])

  return (
    <svg className={'flow-overlay' + (animate ? ' is-animated' : '')} width={size.w} height={size.h} aria-hidden key={version}>
      <defs>
        {(['data', 'mem', 'ctrl'] as const).map((k) => (
          <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className={`flow-head flow-${k}`} />
          </marker>
        ))}
      </defs>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          className={`flow flow-${p.kind} flow-stage-${p.stage}`}
          markerEnd={`url(#arrow-${p.kind})`}
          style={{ strokeDasharray: p.len, ['--len' as string]: p.len }}
        />
      ))}
    </svg>
  )
}
