/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Top-level React ErrorBoundary. One layer, workbench-wide (VSCode pattern).
 *  Pane / View errors bubble up here; the fallback offers a one-click reload.
 *--------------------------------------------------------------------------------------------*/

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { localize, type ILogger } from '@universe-editor/platform'

interface Props {
  logger: ILogger
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class WorkbenchErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.logger.error(
      `[WorkbenchErrorBoundary] ${error.stack ?? error.message}${info.componentStack ?? ''}`,
    )
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    const { error } = this.state

    return (
      <div
        data-testid="workbench-error-boundary"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: 16,
          fontFamily: 'sans-serif',
          color: '#ccc',
          background: '#1e1e1e',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, color: '#f48771' }}>
          {localize('workbenchError.title', 'Something went wrong')}
        </h2>
        {error && (
          <pre
            style={{
              maxWidth: 700,
              overflow: 'auto',
              fontSize: 12,
              color: '#999',
              background: '#2d2d2d',
              padding: '12px 16px',
              borderRadius: 4,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {error.stack ?? error.message}
          </pre>
        )}
        <button
          onClick={() => location.reload()}
          style={{
            padding: '6px 16px',
            background: '#0e639c',
            color: '#fff',
            border: 'none',
            borderRadius: 2,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          {localize('action.reloadWindow.title', 'Reload Window')}
        </button>
      </div>
    )
  }
}
