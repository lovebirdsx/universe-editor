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

/** Stub the connection plumbing so document-sync dedupe is testable without a
 *  real spawn: `_ready` resolves to a token, `_notify` records the wire calls. */
interface SyncInternals {
  _ready(): Promise<unknown>
  _notify(conn: unknown, method: string, params: unknown): void
  _generation: number
  _open: Map<string, { sentGeneration: number; sentVersion: number }>
}

function makeSyncClient() {
  const client = new LspClient('cli', 'tsserver', '/ws', () => {})
  const internals = client as unknown as SyncInternals
  const sent: Array<{ method: string; params: unknown }> = []
  internals._ready = async () => ({})
  internals._notify = (_conn, method, params) => sent.push({ method, params })
  internals._generation = 1
  return { client, internals, sent }
}

describe('LspClient didOpen dedupe (generation guard)', () => {
  const uri = 'file:///ws/big.d.ts'

  it('sends the full text once for duplicate didOpen calls', async () => {
    const { client, sent } = makeSyncClient()
    const open = () =>
      client.didOpen(
        uri,
        'typescript',
        () => 1,
        () => 'text',
      )
    await Promise.all([open(), open()])
    expect(sent.filter((s) => s.method === 'textDocument/didOpen')).toHaveLength(1)
  })

  it('skips the send when a start replay already delivered the doc', async () => {
    const { client, internals, sent } = makeSyncClient()
    internals._ready = async () => {
      // Simulate _start's replay racing this didOpen: it already sent the doc
      // on the new connection generation.
      const doc = internals._open.get(uri)!
      doc.sentGeneration = internals._generation
      return {}
    }
    await client.didOpen(
      uri,
      'typescript',
      () => 1,
      () => 'text',
    )
    expect(sent).toHaveLength(0)
  })

  it('pin then real open: one didOpen, and a reconcile didChange only when the version moved', async () => {
    const { client, sent } = makeSyncClient()
    await client.pinProject(uri, 'typescript', 'pinned text')
    expect(sent.filter((s) => s.method === 'textDocument/didOpen')).toHaveLength(1)

    // Same version as the pin → no traffic at all.
    await client.didOpen(
      uri,
      'typescript',
      () => 1,
      () => 'pinned text',
    )
    expect(sent).toHaveLength(1)

    // Dirty-restored model is ahead of the pin snapshot → full-replace didChange.
    await client.didOpen(
      uri,
      'typescript',
      () => 3,
      () => 'live text',
    )
    expect(sent.map((s) => s.method)).toEqual(['textDocument/didOpen', 'textDocument/didChange'])
    expect(sent[1]?.params).toMatchObject({
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: 'live text' }],
    })
  })

  it('real open then pin: the pin does not resend', async () => {
    const { client, sent } = makeSyncClient()
    await client.didOpen(
      uri,
      'typescript',
      () => 1,
      () => 'text',
    )
    await client.pinProject(uri, 'typescript', 'stale snapshot')
    expect(sent.filter((s) => s.method === 'textDocument/didOpen')).toHaveLength(1)
  })
})

describe('LspClient OOM detection', () => {
  interface OomInternals {
    _proc: unknown
    _stderrTail: string[]
    _restartTimestamps: number[]
    _maxTsServerMemoryMb: number
    _onProcGone(proc: unknown, reason: string): void
  }

  function makeCrashedClient(stderrLines: string[]) {
    const client = new LspClient('cli', 'tsserver', '/ws', () => {})
    const internals = client as unknown as OomInternals
    const proc = {}
    internals._proc = proc
    internals._stderrTail.push(...stderrLines)
    // Saturate the restart window so _onProcGone settles to error instead of
    // spawning a real process from the unit test.
    internals._restartTimestamps.push(Date.now(), Date.now(), Date.now(), Date.now(), Date.now())
    const oomEvents: number[] = []
    client.onServerOOM((mb) => oomEvents.push(mb))
    return { internals, proc, oomEvents }
  }

  it('fires onServerOOM once when stderr carries the exit-134 signature', () => {
    const { internals, proc, oomEvents } = makeCrashedClient([
      'Error: tsserver process has exited (exit code: 134, signal: null). Stopping the server.',
    ])
    internals._maxTsServerMemoryMb = 3072
    internals._proc = proc
    internals._onProcGone(proc, 'exit code=1 signal=null')
    expect(oomEvents).toEqual([3072])
    // Second crash with the same signature: notify only once.
    internals._proc = proc
    internals._onProcGone(proc, 'exit code=1 signal=null')
    expect(oomEvents).toEqual([3072])
  })

  it('stays quiet for a non-OOM crash', () => {
    const { internals, proc, oomEvents } = makeCrashedClient(['some unrelated stack line'])
    internals._onProcGone(proc, 'exit code=1 signal=null')
    expect(oomEvents).toEqual([])
  })
})
