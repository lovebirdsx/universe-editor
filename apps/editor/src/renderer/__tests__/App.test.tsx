import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { App } from '../App.js'
import type { PingResult } from '../../shared/ipc-channels.js'

describe('<App />', () => {
  beforeEach(() => {
    const result: PingResult = {
      pong: true,
      rendererSentAt: 1_700_000_000_000,
      mainReceivedAt: 1_700_000_000_005,
    }
    window.api = {
      ping: vi.fn().mockResolvedValue(result),
      storage: {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      },
    }
  })

  it('renders heading', () => {
    render(<App />)
    expect(screen.getByText('Universe Editor')).toBeTruthy()
  })

  it('invokes window.api.ping on mount and shows result', async () => {
    render(<App />)
    expect(screen.getByText(/Pinging main process/)).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText(/round trip:/)).toBeTruthy()
    })
    expect(window.api.ping).toHaveBeenCalledTimes(1)
  })
})
