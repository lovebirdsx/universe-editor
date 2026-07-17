/*---------------------------------------------------------------------------------------------
 *  Tests for LspClient's readiness state machine. "Ready" tracks tsserver's
 *  project load (reported via `$/progress`, title "Initializing JS/TS…"), not the
 *  near-instant `initialize` handshake — otherwise the indicator flashes by.
 *
 *  The constructor doesn't spawn (only `_ready`/`_start` do), so we can construct
 *  a client and drive the private progress handler / grace timer directly,
 *  observing state through the public `onDidChangeState`.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LspClient, type LspServerState } from '../lspClient.js'

interface ProgressValue {
  kind: 'begin' | 'report' | 'end'
  title?: string
}

/** Reach into the private progress plumbing the state machine is built on. */
interface Internals {
  _onProgress(params: { token: number | string; value: ProgressValue }): void
  _armReadyGrace(): void
  _awaitingProjectLoad: boolean
}

function makeClient(): { client: LspClient; internals: Internals; states: LspServerState[] } {
  const client = new LspClient('cli', 'tsserver', '/ws', () => {})
  const states: LspServerState[] = []
  client.onDidChangeState((s) => states.push(s))
  return { client, internals: client as unknown as Internals, states }
}

const begin = (token: number | string, title = 'Initializing JS/TS language features…') => ({
  token,
  value: { kind: 'begin' as const, title },
})
const end = (token: number | string) => ({ token, value: { kind: 'end' as const } })

describe('LspClient readiness state machine', () => {
  it('starts in the starting state', () => {
    const { client } = makeClient()
    expect(client.state).toBe('starting')
  })

  it('goes ready only when the loading project finishes', () => {
    const { client, internals, states } = makeClient()
    internals._onProgress(begin(1))
    expect(client.state).toBe('starting')
    internals._onProgress(end(1))
    expect(client.state).toBe('ready')
    expect(states).toEqual(['ready']) // was already 'starting'; only the transition fires
  })

  it('stays starting until every concurrent project load finishes (monorepo)', () => {
    const { client, internals } = makeClient()
    internals._onProgress(begin(1))
    internals._onProgress(begin(2))
    internals._onProgress(end(1))
    expect(client.state).toBe('starting') // token 2 still loading
    internals._onProgress(end(2))
    expect(client.state).toBe('ready')
  })

  it('ignores unrelated workDoneProgress (e.g. go-to-source-definition)', () => {
    const { client, internals } = makeClient()
    internals._onProgress(begin(9, 'Finding source definitions'))
    internals._onProgress(end(9))
    // Never entered project-load tracking, so no ready transition from this.
    expect(client.state).toBe('starting')
  })

  it('re-enters starting when a new project load begins after ready', () => {
    const { client, internals, states } = makeClient()
    internals._onProgress(begin(1))
    internals._onProgress(end(1))
    expect(client.state).toBe('ready')
    internals._onProgress(begin(2))
    expect(client.state).toBe('starting')
    expect(states).toEqual(['ready', 'starting'])
  })

  describe('grace timer', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('settles to ready if no project load begins within the grace window', () => {
      const { client, internals } = makeClient()
      internals._awaitingProjectLoad = true
      internals._armReadyGrace()
      expect(client.state).toBe('starting')
      vi.advanceTimersByTime(2_000)
      expect(client.state).toBe('ready')
    })

    it('does not settle early when a project load has already begun', () => {
      const { client, internals } = makeClient()
      internals._awaitingProjectLoad = true
      internals._armReadyGrace()
      internals._onProgress(begin(1)) // cancels the grace timer, clears awaiting
      vi.advanceTimersByTime(2_000)
      expect(client.state).toBe('starting') // still loading; grace must not force ready
      internals._onProgress(end(1))
      expect(client.state).toBe('ready')
    })
  })
})
