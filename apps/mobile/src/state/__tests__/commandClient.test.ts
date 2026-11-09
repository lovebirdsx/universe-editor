import type { CommandFrame } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { FakeTimers } from '../../test/fakes.js'
import { commandErrorText, strings } from '../../strings.js'
import {
  COMMAND_TIMEOUT_GRACE_MS,
  COMMAND_TIMEOUT_MS,
  CommandClient,
  CommandError,
  createCommandId,
  type CommandClientOptions,
} from '../commandClient.js'

interface Harness {
  readonly client: CommandClient
  readonly sent: CommandFrame[]
  readonly timers: FakeTimers
}

function createHarness(overrides: Partial<CommandClientOptions> = {}): Harness {
  const sent: CommandFrame[] = []
  const timers = new FakeTimers()
  let requestCounter = 0
  let idempotencyCounter = 0
  const client = new CommandClient({
    send: (frame) => sent.push(frame),
    timers,
    createRequestId: () => `request-${++requestCounter}`,
    createIdempotencyKey: () => `idem-${++idempotencyCounter}`,
    ...overrides,
  })
  return { client, sent, timers }
}

describe('CommandClient', () => {
  it('correlates a command_result by requestId', async () => {
    const { client, sent } = createHarness()
    const promise = client.request<readonly string[]>('listAgents', {})

    expect(sent[0]).toMatchObject({ type: 'command', kind: 'listAgents' })
    expect(
      client.handleResult({
        type: 'command_result',
        requestId: sent[0]!.requestId,
        ok: true,
        result: ['echo'],
      }),
    ).toBe(true)
    await expect(promise).resolves.toEqual(['echo'])
  })

  it('uses the per-kind timeout table', async () => {
    expect(COMMAND_TIMEOUT_MS.sendPrompt).toBe(15_000)
    expect(COMMAND_TIMEOUT_MS.cancelTurn).toBe(5_000)
    expect(COMMAND_TIMEOUT_MS.resolvePermission).toBe(10_000)
    expect(COMMAND_TIMEOUT_MS.setConfigOption).toBe(10_000)
    expect(COMMAND_TIMEOUT_MS.newSession).toBe(30_000)
    expect(COMMAND_TIMEOUT_MS.deleteSession).toBe(30_000)
    expect(COMMAND_TIMEOUT_MS.forkSession).toBe(120_000)
    expect(COMMAND_TIMEOUT_MS.previewRewind).toBe(30_000)
    expect(COMMAND_TIMEOUT_MS.rewindSession).toBe(120_000)
    expect(COMMAND_TIMEOUT_MS.createSideTask).toBe(120_000)
    expect(COMMAND_TIMEOUT_MS.listSideTasks).toBe(10_000)
    expect(COMMAND_TIMEOUT_MS.openSideTask).toBe(120_000)
    expect(COMMAND_TIMEOUT_MS.deleteSideTask).toBe(120_000)
    expect(COMMAND_TIMEOUT_MS.listWorkspaces).toBe(10_000)
    expect(COMMAND_TIMEOUT_MS.listSessionHistory).toBe(20_000)
    expect(COMMAND_TIMEOUT_MS.openSession).toBe(120_000)

    const { client, timers } = createHarness()
    const outcome = client.request('sendPrompt', { ref: {}, text: 'hi' }).catch((error) => error)
    timers.advance(COMMAND_TIMEOUT_MS.sendPrompt + COMMAND_TIMEOUT_GRACE_MS - 1)
    expect(timers.pendingTimeoutDelays()).toEqual([1])
    timers.advance(1)
    const error = await outcome
    expect(error).toBeInstanceOf(CommandError)
    expect(error).toMatchObject({ code: 'timeout' })
  })

  it('waits past the gateway deadline before giving up', () => {
    const { client, timers } = createHarness()
    void client.request('newSession', { agentId: 'echo', workspace: { folder: 'file:///ws' } })
    expect(timers.pendingTimeoutDelays()).toEqual([
      COMMAND_TIMEOUT_MS.newSession + COMMAND_TIMEOUT_GRACE_MS,
    ])
  })

  it('adds an idempotency key to mutating commands only', () => {
    const { client, sent } = createHarness()
    void client.request('sendPrompt', { ref: {}, text: 'hi' })
    void client.request('listAgents', {})
    void client.request('forkSession', { ref: {} })
    void client.request('rewindSession', { ref: {}, messageId: 'm' })
    void client.request('createSideTask', { ref: {} })
    void client.request('openSideTask', { ref: {}, sideTaskId: 's' })
    void client.request('deleteSideTask', { ref: {}, sideTaskId: 's' })
    void client.request('previewRewind', { ref: {}, messageId: 'm' })
    void client.request('listSideTasks', { ref: {} })
    void client.request('openSession', { durableId: 'durable-1' })
    void client.request('listSessionHistory', {})
    expect(sent[0]?.idempotencyKey).toBe('idem-1')
    expect(sent[1]?.idempotencyKey).toBeUndefined()
    for (const index of [2, 3, 4, 5, 6]) {
      expect(sent[index]?.idempotencyKey).toBeTruthy()
    }
    expect(sent[7]?.idempotencyKey).toBeUndefined()
    expect(sent[8]?.idempotencyKey).toBeUndefined()
    expect(sent[9]?.idempotencyKey).toBeTruthy()
    expect(sent[10]?.idempotencyKey).toBeUndefined()
  })

  it('reuses the requestId and idempotency key when resending after a reconnect', () => {
    const { client, sent } = createHarness()
    void client.request('sendPrompt', { ref: { windowId: 1, localId: 's1' }, text: 'hi' })

    client.resendPending()

    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
    expect(sent[1]?.idempotencyKey).toBe('idem-1')
  })

  it('treats stale_request as success for approval commands', async () => {
    const { client, sent } = createHarness()
    const promise = client.request<void>('resolvePermission', {}, { treatStaleAsSuccess: true })
    client.handleResult({
      type: 'command_result',
      requestId: sent[0]!.requestId,
      ok: false,
      error: 'stale_request',
    })
    await expect(promise).resolves.toBeUndefined()
  })

  it('reports stale_request as an error when not opted in', async () => {
    const { client, sent } = createHarness()
    const promise = client.request('getToolCallDetail', {})
    const rejection = expect(promise).rejects.toMatchObject({ code: 'stale_request' })
    client.handleResult({
      type: 'command_result',
      requestId: sent[0]!.requestId,
      ok: false,
      error: 'stale_request',
    })
    await rejection
  })

  it('rejects malformed results through the validator', async () => {
    const { client, sent } = createHarness()
    const promise = client.request(
      'getToolCallDetail',
      {},
      {
        validateResult: (value) => typeof value === 'object' && value !== null,
      },
    )
    const rejection = expect(promise).rejects.toMatchObject({ code: 'invalid_response' })
    client.handleResult({
      type: 'command_result',
      requestId: sent[0]!.requestId,
      ok: true,
      result: 'not-an-object',
    })
    await rejection
  })

  it('rejects up front when the socket refuses the frame', async () => {
    const client = new CommandClient({
      send: () => {
        throw new Error('socket closed')
      },
    })
    await expect(client.request('sendPrompt', {})).rejects.toMatchObject({ code: 'network' })
    expect(client.pendingCount).toBe(0)
  })

  it('rejects every pending request when cleared', async () => {
    const { client } = createHarness()
    const pending = client.request('listAgents', {})
    const rejection = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    client.clear()
    await rejection
    expect(client.pendingCount).toBe(0)
  })

  it('maps error codes to Chinese copy', () => {
    expect(commandErrorText('forbidden_operation')).toContain('不允许')
    expect(commandErrorText('workspace_not_open')).toContain('工作区')
    expect(commandErrorText('timeout')).toContain('PC 未响应')
    expect(commandErrorText('unknown-code')).toBe(strings.sessionActionFailed)
    expect(commandErrorText(undefined)).toBe(strings.sessionActionFailed)
  })

  it('creates unique uuid-shaped request ids', () => {
    const first = createCommandId()
    const second = createCommandId()
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
