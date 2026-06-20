/*---------------------------------------------------------------------------------------------
 *  Tests for AiDebugMainService — record passthrough to the recorder and offline
 *  replay (re-emits a record's chunks as mock data over replayId-keyed events,
 *  with an end signal carrying the original error when present).
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AiMessageRole,
  type AiMessage,
  type AiResponseChunk,
  type SerializedError,
} from '@universe-editor/platform'
import { AiDebugRecorder } from '../aiDebugRecorder.js'
import { AiDebugMainService } from '../aiDebugService.js'
import type { LogMainService } from '../../log/logMainService.js'
import type { AiReplayChunkEvent, AiReplayEndEvent } from '../../../../shared/ipc/aiDebugService.js'

function makeService(): {
  service: AiDebugMainService
  recorder: AiDebugRecorder
} {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debug-svc-test-'))
  const logMain = { getSessionDir: () => dir } as unknown as LogMainService
  const recorder = new AiDebugRecorder(logMain)
  const service = new AiDebugMainService(recorder)
  return { service, recorder }
}

function userMessage(text: string): AiMessage {
  return { role: AiMessageRole.User, content: [{ type: 'text', value: text }] }
}

describe('AiDebugMainService', () => {
  let disposers: Array<{ dispose(): void }> = []
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposers.push(x)
    return x
  }
  afterEach(() => {
    for (const d of disposers) d.dispose()
    disposers = []
  })

  function seedRecord(recorder: AiDebugRecorder, error?: SerializedError): string {
    recorder.begin('req1', [userMessage('hi')], { modelId: 'openai/default/m' })
    recorder.recordChunk('req1', { type: 'text', value: 'A' })
    recorder.recordChunk('req1', { type: 'text', value: 'B' })
    recorder.finish('req1', error)
    return recorder.listRecords()[0]!.id
  }

  it('lists recorded requests through the service', async () => {
    const { service, recorder } = makeService()
    track(recorder)
    track(service)
    seedRecord(recorder)
    const list = await service.listRecords()
    expect(list).toHaveLength(1)
  })

  it('replays a record by re-emitting its chunks then ending', async () => {
    const { service, recorder } = makeService()
    track(recorder)
    track(service)
    const id = seedRecord(recorder)

    const chunks: AiResponseChunk[] = []
    let endEvent: AiReplayEndEvent | undefined
    service.onDidReplayChunk((e: AiReplayChunkEvent) => chunks.push(e.chunk))
    const ended = new Promise<void>((resolve) => {
      service.onDidReplayEnd((e) => {
        endEvent = e
        resolve()
      })
    })

    const replayId = await service.replayRecord(id)
    expect(replayId).toBeDefined()
    await ended

    expect(chunks).toEqual([
      { type: 'text', value: 'A' },
      { type: 'text', value: 'B' },
    ])
    expect(endEvent?.replayId).toBe(replayId)
    expect(endEvent?.error).toBeUndefined()
  })

  it('replays the original error on the end event', async () => {
    const { service, recorder } = makeService()
    track(recorder)
    track(service)
    const id = seedRecord(recorder, { $isError: true, name: 'Error', message: 'boom' })

    let endEvent: AiReplayEndEvent | undefined
    const ended = new Promise<void>((resolve) => {
      service.onDidReplayEnd((e) => {
        endEvent = e
        resolve()
      })
    })
    await service.replayRecord(id)
    await ended
    expect(endEvent?.error?.message).toBe('boom')
  })

  it('returns undefined when replaying an unknown record', async () => {
    const { service, recorder } = makeService()
    track(recorder)
    track(service)
    expect(await service.replayRecord('nope')).toBeUndefined()
  })
})
