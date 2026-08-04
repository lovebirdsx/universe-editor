/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/telemetry/telemetryClientService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryClientService } from '../telemetryClientService.js'
import type { IErrorSinkService, WireErrorRecord } from '../../../../shared/ipc/services.js'

function makeSink(): IErrorSinkService & { calls: WireErrorRecord[][] } {
  const calls: WireErrorRecord[][] = []
  return {
    calls,
    _serviceBrand: undefined,
    ingestErrors: (records) => {
      calls.push([...records])
      return Promise.resolve()
    },
  }
}

const STACK = 'Error: boom\n    at run (D:\\app\\src\\thing\\doer.ts:10:5)'

describe('TelemetryClientService', () => {
  let telemetry: TelemetryClientService
  let sink: ReturnType<typeof makeSink>

  beforeEach(() => {
    vi.useFakeTimers()
    telemetry = new TelemetryClientService()
    sink = makeSink()
  })

  afterEach(() => {
    telemetry.dispose()
    vi.useRealTimers()
  })

  async function tick(): Promise<void> {
    await vi.advanceTimersByTimeAsync(1)
  }

  it('buffers until the sink binds, then flushes', async () => {
    telemetry.publicLogError('unhandledError', { stack: STACK, message: 'boom' })
    await tick()
    expect(sink.calls).toHaveLength(0) // no sink yet — nothing sent, nothing lost
    telemetry.bindSink(sink)
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]?.[0]).toMatchObject({
      event: 'unhandledError',
      fingerprint: 'run@thing/doer.ts',
      message: 'boom',
      count: 1,
    })
  })

  it('folds same-tick duplicates into one IPC call with a count', async () => {
    telemetry.bindSink(sink)
    telemetry.publicLogError('unhandledError', { stack: STACK, message: 'boom' })
    telemetry.publicLogError('unhandledError', { stack: STACK, message: 'boom' })
    telemetry.publicLogError('unhandledError', { stack: STACK, message: 'boom' })
    await tick()
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]).toHaveLength(1)
    expect(sink.calls[0]?.[0]?.count).toBe(3)
  })

  it('keeps distinct events / stacks as separate records in one batch', async () => {
    telemetry.bindSink(sink)
    telemetry.publicLogError('unhandledError', { stack: STACK, message: 'boom' })
    telemetry.publicLogError('acp.prompt_failed', { error: 'agent died' })
    await tick()
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]).toHaveLength(2)
  })

  it('message falls back through error → stack first line → event name', async () => {
    telemetry.bindSink(sink)
    telemetry.publicLogError('evt.a', { error: 'from error field' })
    telemetry.publicLogError('evt.b', { stack: STACK })
    telemetry.publicLogError('evt.c', {})
    await tick()
    const batch = sink.calls[0] ?? []
    const byEvent = new Map(batch.map((r) => [r.event, r]))
    expect(byEvent.get('evt.a')?.message).toBe('from error field')
    expect(byEvent.get('evt.b')?.message).toBe('Error: boom')
    expect(byEvent.get('evt.c')?.message).toBe('evt.c')
  })

  it('extracts scalar dimensions and excludes the lifted error fields', async () => {
    telemetry.bindSink(sink)
    telemetry.publicLogError('acp.prompt_failed', {
      error: 'agent died',
      sessionId: 'sess-1',
      attempt: 2,
      retriable: true,
      nested: undefined,
    })
    await tick()
    expect(sink.calls[0]?.[0]?.dimensions).toEqual({
      sessionId: 'sess-1',
      attempt: 2,
      retriable: true,
    })
  })

  it('stays silent while collection is disabled and drops pending on disable', async () => {
    telemetry.bindSink(sink)
    telemetry.publicLogError('unhandledError', { message: 'kept' })
    telemetry.setCollectionEnabled(false)
    telemetry.publicLogError('unhandledError', { message: 'dropped' })
    await tick()
    expect(sink.calls).toHaveLength(0)
    telemetry.setCollectionEnabled(true)
    telemetry.publicLogError('unhandledError', { message: 'after' })
    await tick()
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]?.[0]?.message).toBe('after')
  })

  it('requeues records when the IPC call fails', async () => {
    const failing: IErrorSinkService = {
      _serviceBrand: undefined,
      ingestErrors: () => Promise.reject(new Error('channel gone')),
    }
    telemetry.bindSink(failing)
    telemetry.publicLogError('unhandledError', { message: 'retry me' })
    await tick()
    await tick() // let the rejection land and requeue
    telemetry.bindSink(sink)
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]?.[0]?.message).toBe('retry me')
  })

  it('does not leak the internal dedupKey onto the wire', async () => {
    telemetry.bindSink(sink)
    telemetry.publicLogError('unhandledError', { stack: STACK, message: 'boom' })
    await tick()
    expect(sink.calls[0]?.[0]).not.toHaveProperty('dedupKey')
  })

  it('getTelemetryInfo returns a stable session id', async () => {
    const a = await telemetry.getTelemetryInfo()
    const b = await telemetry.getTelemetryInfo()
    expect(a.sessionId).toBe(b.sessionId)
    expect(a.sessionId.length).toBeGreaterThan(0)
  })
})
