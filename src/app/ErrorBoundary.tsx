import { Component, type ReactNode } from 'react'
import { t } from '../i18n'

/** Keeps a rendering bug from blanking the whole app; offers a reload instead. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h2>{t().ui.crashTitle}</h2>
        <pre>{this.state.error.message}</pre>
        <p>{t().ui.crashSaved}</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
          {t().ui.reload}
        </button>
      </div>
    )
  }
}
