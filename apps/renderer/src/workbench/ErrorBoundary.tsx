import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const api = (window as unknown as { logicreader?: { log: { write: (...a: unknown[]) => Promise<void> } } }).logicreader
    void api?.log.write('error', 'renderer', error.message, (info.componentStack ?? '').slice(0, 4000))
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="lr-boot-error">
          <h1>界面出现异常</h1>
          <pre>{this.state.error.message}</pre>
          <button
            className="lr-button"
            onClick={() => {
              this.setState({ error: null })
            }}
          >
            重试 / Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
