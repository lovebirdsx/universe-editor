import { useEffect, useState } from 'react'
import type { PingResult } from '../shared/ipc-channels.js'

type PingState =
  | { status: 'idle' }
  | { status: 'pinging' }
  | { status: 'ok'; result: PingResult; roundTripMs: number }
  | { status: 'error'; message: string }

export function App() {
  const [state, setState] = useState<PingState>({ status: 'idle' })

  const runPing = async () => {
    setState({ status: 'pinging' })
    const sentAt = Date.now()
    try {
      const result = await window.api.ping(sentAt)
      setState({ status: 'ok', result, roundTripMs: Date.now() - sentAt })
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  useEffect(() => {
    void runPing()
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1 style={{ marginBottom: '0.5rem' }}>Universe Editor</h1>
      <p style={{ color: '#666', marginBottom: '1.5rem' }}>
        M0 scaffold — Electron + React + Vite + Vitest
      </p>

      <section
        style={{
          border: '1px solid #e5e7eb',
          borderRadius: '0.5rem',
          padding: '1rem',
          maxWidth: 520,
        }}
      >
        <h2 style={{ margin: 0, marginBottom: '0.75rem' }}>IPC ping/pong</h2>
        {state.status === 'idle' && <p>Idle.</p>}
        {state.status === 'pinging' && <p>Pinging main process…</p>}
        {state.status === 'ok' && (
          <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li>renderer → main: {state.result.mainReceivedAt - state.result.rendererSentAt} ms</li>
            <li>round trip: {state.roundTripMs} ms</li>
            <li>main timestamp: {new Date(state.result.mainReceivedAt).toISOString()}</li>
          </ul>
        )}
        {state.status === 'error' && <p style={{ color: '#dc2626' }}>Error: {state.message}</p>}
        <button
          type="button"
          onClick={() => void runPing()}
          disabled={state.status === 'pinging'}
          style={{
            marginTop: '0.75rem',
            padding: '0.5rem 0.75rem',
            border: 0,
            borderRadius: '0.375rem',
            background: '#2563eb',
            color: 'white',
            cursor: 'pointer',
          }}
        >
          Ping again
        </button>
      </section>
    </main>
  )
}
