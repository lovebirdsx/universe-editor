import type { CommandFrame, MobileToolCallDetail } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { FakeTimers } from '../../test/fakes.js'
import { sessionRef } from '../../test/protocolFixtures.js'
import {
  TOOL_CALL_DETAIL_TIMEOUT_MS,
  ToolCallDetailClient,
  ToolCallDetailError,
} from '../toolCallDetailClient.js'

function detail(id = 't1'): MobileToolCallDetail {
  return {
    id,
    title: 'Echo',
    kind: 'execute',
    status: 'completed',
    text: 'hello',
    diffs: [],
  }
}

function createClient(): {
  readonly client: ToolCallDetailClient
  readonly sent: CommandFrame[]
  readonly timers: FakeTimers
} {
  const sent: CommandFrame[] = []
  const timers = new FakeTimers()
  const client = new ToolCallDetailClient({
    send: (frame) => sent.push(frame),
    timers,
  })
  return { client, sent, timers }
}

describe('ToolCallDetailClient', () => {
  it('correlates a command_result with the pending request', async () => {
    const { client, sent } = createClient()
    const promise = client.request(sessionRef('s1'), 't1')

    expect(sent).toHaveLength(1)
    const frame = sent[0]!
    expect(frame).toMatchObject({
      type: 'command',
      kind: 'getToolCallDetail',
      payload: { ref: sessionRef('s1'), toolCallId: 't1' },
    })

    expect(
      client.handleResult({
        type: 'command_result',
        requestId: frame.requestId,
        ok: true,
        result: detail(),
      }),
    ).toBe(true)
    await expect(promise).resolves.toEqual(detail())
  })

  it('times out after 10 seconds', async () => {
    const { client, timers } = createClient()
    const promise = client.request(sessionRef('s1'), 't1')
    const outcome = promise.catch((error: unknown) => error)
    timers.advance(TOOL_CALL_DETAIL_TIMEOUT_MS - 1)
    expect(timers.pendingTimeoutDelays()).toEqual([1])

    timers.advance(1)
    const error = await outcome
    expect(error).toBeInstanceOf(ToolCallDetailError)
    expect(error).toMatchObject({ code: 'timeout' })
  })

  it('rejects with the gateway error code', async () => {
    const { client, sent } = createClient()
    const promise = client.request(sessionRef('s1'), 't1')
    const rejection = expect(promise).rejects.toMatchObject({ code: 'session_not_found' })
    client.handleResult({
      type: 'command_result',
      requestId: sent[0]!.requestId,
      ok: false,
      error: 'session_not_found',
    })
    await rejection
  })

  it('caches a successful result per tool call until invalidated', async () => {
    const { client, sent } = createClient()
    const first = client.request(sessionRef('s1'), 't1')
    client.handleResult({
      type: 'command_result',
      requestId: sent[0]!.requestId,
      ok: true,
      result: detail(),
    })
    await first

    await expect(client.request(sessionRef('s1'), 't1')).resolves.toEqual(detail())
    expect(sent).toHaveLength(1)

    client.invalidate('t1')
    const third = client.request(sessionRef('s1'), 't1')
    expect(sent).toHaveLength(2)
    expect(
      client.handleResult({
        type: 'command_result',
        requestId: sent[1]!.requestId,
        ok: true,
        result: detail(),
      }),
    ).toBe(true)
    await third
  })

  it('rejects pending requests when cleared', async () => {
    const { client } = createClient()
    const promise = client.request(sessionRef('s1'), 't1')
    const rejection = expect(promise).rejects.toMatchObject({ code: 'cancelled' })
    client.clear()
    await rejection
  })

  it('ignores results that match no pending request', () => {
    const { client } = createClient()
    expect(
      client.handleResult({
        type: 'command_result',
        requestId: 'missing',
        ok: true,
        result: detail(),
      }),
    ).toBe(false)
  })
})
