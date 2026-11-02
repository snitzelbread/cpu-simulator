import type { ReactNode } from 'react'

export function Panel(props: { title: string; area: string; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  const id = props.id ?? `panel-${props.area}`
  return (
    <section className={'panel ' + (props.className ?? '')} style={{ gridArea: props.area }} aria-labelledby={id}>
      <header className="panel-header">
        <h2 id={id}>{props.title}</h2>
        {props.actions && <div className="panel-actions">{props.actions}</div>}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  )
}
