import { Component, type ReactNode } from 'react'

/** A bug on one screen must never leave the whole window blank. */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset: () => void; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('screen crashed', error)
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page" style={{ maxWidth: 640 }}>
        <div className="panel stack" data-testid="screen-error">
          <h2>Sorry, this screen hit a problem</h2>
          <p className="muted">Your videos are safe. Go back and try again. If it keeps happening, restart Reel Studio.</p>
          <div className="row">
            <button className="btn primary" onClick={() => { this.setState({ error: null }); this.props.onReset() }}>
              Back to My videos
            </button>
          </div>
        </div>
      </div>
    )
  }
}
