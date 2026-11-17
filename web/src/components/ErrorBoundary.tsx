import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Keeps one broken piece (a widget fed odd tool data, a bad restored message) from blanking the app. */
export class ErrorBoundary extends Component<{ fallback: (reset: () => void) => ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error boundary caught:', error, info.componentStack)
  }

  reset = () => this.setState({ failed: false })

  render() {
    return this.state.failed ? this.props.fallback(this.reset) : this.props.children
  }
}

export function WidgetFallback({ tool }: { tool: string }) {
  return (
    <p className="rounded-3xl bg-muted px-5 py-3.5 text-sm text-muted-foreground" role="note">
      The {tool} chart could not be drawn from this tool result. The answer above is unaffected.
    </p>
  )
}
