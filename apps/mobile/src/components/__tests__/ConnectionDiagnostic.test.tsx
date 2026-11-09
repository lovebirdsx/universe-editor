import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionDiagnostic } from '../ConnectionDiagnostic.js'
import { strings } from '../../strings.js'
import type { ConnectionDiagnosis } from '../../socket/connectionDiagnosis.js'

const ORIGIN = 'https://192.0.2.10:47321'

function renderDiagnostic(diagnosis: ConnectionDiagnosis | undefined) {
  const onRetryConnection = vi.fn()
  const onRecheck = vi.fn()
  render(
    <ConnectionDiagnostic
      diagnosis={diagnosis}
      onRetryConnection={onRetryConnection}
      onRecheck={onRecheck}
    />,
  )
  return { onRetryConnection, onRecheck }
}

describe('ConnectionDiagnostic', () => {
  it('renders nothing before a diagnosis exists', () => {
    renderDiagnostic(undefined)
    expect(screen.queryByTestId('connection-diagnostic')).toBeNull()
  })

  it('shows the unreachable checklist for a network error', () => {
    const { onRetryConnection, onRecheck } = renderDiagnostic({
      kind: 'network-error',
      origin: ORIGIN,
    })

    expect(screen.getByTestId('connection-diagnostic').dataset['kind']).toBe('network-error')
    expect(screen.getByText(strings.connectionDiagnosticUnreachable(ORIGIN))).toBeTruthy()
    expect(screen.getByTestId('connection-diagnostic-origin').textContent).toContain(ORIGIN)
    expect(screen.getByText(strings.connectionDiagnosticHintLocalNetwork)).toBeTruthy()

    fireEvent.click(screen.getByTestId('connection-diagnostic-retry'))
    expect(onRetryConnection).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('connection-diagnostic-recheck'))
    expect(onRecheck).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('connection-diagnostic-refresh')).toBeNull()
  })

  it('explains that HTTP reached the PC when only the WebSocket fails', () => {
    renderDiagnostic({ kind: 'ok', origin: ORIGIN })

    expect(screen.getByText(strings.connectionDiagnosticReachable)).toBeTruthy()
    expect(screen.getByText(strings.connectionDiagnosticHintCertInstall)).toBeTruthy()
    expect(screen.getByTestId('connection-diagnostic-ca').getAttribute('href')).toBe('/api/cert')
    expect(screen.getByTestId('connection-diagnostic-retry')).toBeTruthy()
    expect(screen.getByTestId('connection-diagnostic-refresh')).toBeTruthy()
  })

  it('does not offer a socket retry when the host is rejected', () => {
    renderDiagnostic({ kind: 'forbidden', origin: ORIGIN, status: 403 })

    expect(screen.getByText(strings.connectionDiagnosticForbidden)).toBeTruthy()
    expect(screen.queryByTestId('connection-diagnostic-retry')).toBeNull()
    expect(screen.getByTestId('connection-diagnostic-recheck')).toBeTruthy()
  })

  it('offers a refresh after a protocol mismatch', () => {
    renderDiagnostic({ kind: 'protocol-mismatch', origin: ORIGIN, protocolVersion: 99 })

    expect(screen.getByText(strings.connectionDiagnosticProtocolMismatch)).toBeTruthy()
    expect(screen.getByTestId('connection-diagnostic-refresh')).toBeTruthy()
    expect(screen.queryByTestId('connection-diagnostic-retry')).toBeNull()
  })

  it('describes an old gateway and unexpected proxy responses', () => {
    renderDiagnostic({ kind: 'not-found', origin: ORIGIN, status: 404 })
    expect(screen.getByText(strings.connectionDiagnosticNotFound)).toBeTruthy()

    renderDiagnostic({ kind: 'invalid-response', origin: ORIGIN, status: 200 })
    expect(screen.getAllByText(strings.connectionDiagnosticInvalidResponse)).toHaveLength(1)
  })

  it('includes the HTTP status on other errors', () => {
    renderDiagnostic({ kind: 'http-error', origin: ORIGIN, status: 502 })
    expect(screen.getByText(strings.connectionDiagnosticHttpError(502))).toBeTruthy()
  })
})
