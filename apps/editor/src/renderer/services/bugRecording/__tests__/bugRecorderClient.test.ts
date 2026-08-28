/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '@universe-editor/platform'
import { BugRecorderClient } from '../bugRecorderClient.js'
import type {
  BugRecordEvent,
  BugRecordingOrphanInfo,
  BugRecordingResult,
  BugRecordingStartMeta,
  BugRecordingStatus,
  BugRecordingStopOptions,
  IBugRecorderService,
} from '../../../../shared/ipc/bugRecorderService.js'

const RESULT: BugRecordingResult = {
  zipPath: '/tmp/bundle.zip',
  eventCount: 3,
  screenshotCount: 1,
  zipSizeBytes: 1024,
}

function createProxy(initial: BugRecordingStatus = { state: 'idle' }) {
  const statusEmitter = new Emitter<BugRecordingStatus>()
  const recorded: BugRecordEvent[][] = []
  let current = initial
  const stopOptions: BugRecordingStopOptions[] = []
  let markSteps = 0
  let orphan: BugRecordingOrphanInfo | null = null

  const proxy: IBugRecorderService = {
    _serviceBrand: undefined,
    onDidChangeStatus: statusEmitter.event,
    startRecording: (meta: BugRecordingStartMeta) => {
      current = { state: 'recording', startedAt: 1000 }
      void meta
      return Promise.resolve(current)
    },
    recordEvents: (events) => {
      recorded.push([...events])
      return Promise.resolve()
    },
    markStep: () => {
      markSteps++
      return Promise.resolve()
    },
    stopRecording: (options) => {
      stopOptions.push(options)
      current = { state: 'idle' }
      return Promise.resolve(RESULT)
    },
    getRecordingStatus: () => Promise.resolve(current),
    consumeOrphanRecording: () => Promise.resolve(orphan),
    exportOrphanRecording: () => Promise.resolve(RESULT),
  }

  return {
    proxy,
    recorded,
    stopOptions,
    fireStatus: (status: BugRecordingStatus) => statusEmitter.fire(status),
    getMarkSteps: () => markSteps,
    setOrphan: (info: BugRecordingOrphanInfo | null) => {
      orphan = info
    },
  }
}

describe('BugRecorderClient', () => {
  it('seeds its status from main so a reloaded window rejoins a live recording', async () => {
    const { proxy } = createProxy({ state: 'recording', startedAt: 42 })
    const client = new BugRecorderClient(proxy)

    await vi.waitFor(() => expect(client.isRecording).toBe(true))
    expect(client.status.get()).toEqual({ state: 'recording', startedAt: 42 })
    client.dispose()
  })

  it('drops events while idle so recording costs nothing when off', () => {
    const { proxy, recorded } = createProxy()
    const client = new BugRecorderClient(proxy)

    client.recordEvent({ kind: 'marker' })
    client.recordTelemetry('commandExecuted', { commandId: 'x' })

    expect(recorded).toHaveLength(0)
    client.dispose()
  })

  it('stamps ts and forwards events once recording', async () => {
    const { proxy, recorded } = createProxy()
    const client = new BugRecorderClient(proxy)
    await client.startRecording({})

    client.recordEvent({ kind: 'commandError', commandId: 'a.b', message: 'boom' })

    expect(recorded).toHaveLength(1)
    const event = recorded[0]?.[0]
    expect(event).toMatchObject({ kind: 'commandError', commandId: 'a.b', message: 'boom' })
    expect(typeof event?.ts).toBe('number')
    client.dispose()
  })

  it('honours an explicitly supplied ts', async () => {
    const { proxy, recorded } = createProxy()
    const client = new BugRecorderClient(proxy)
    await client.startRecording({})

    client.recordEvent({ kind: 'marker', ts: 777 })

    expect(recorded[0]?.[0]?.ts).toBe(777)
    client.dispose()
  })

  it('keeps only wire-safe telemetry values and omits data when nothing survives', async () => {
    const { proxy, recorded } = createProxy()
    const client = new BugRecorderClient(proxy)
    await client.startRecording({})

    client.recordTelemetry('acp.prompt_sent', {
      commandId: 'x',
      count: 3,
      flag: true,
      nested: { a: 1 },
      missing: undefined,
    })
    client.recordTelemetry('editorOpened', { nested: { a: 1 } })

    expect(recorded[0]?.[0]).toMatchObject({
      kind: 'telemetry',
      name: 'acp.prompt_sent',
      data: { commandId: 'x', count: 3, flag: true },
    })
    expect(recorded[1]?.[0]).not.toHaveProperty('data')
    client.dispose()
  })

  it('mirrors status broadcasts from main', () => {
    const { proxy, fireStatus } = createProxy()
    const client = new BugRecorderClient(proxy)

    fireStatus({ state: 'recording', startedAt: 5 })
    expect(client.isRecording).toBe(true)

    fireStatus({ state: 'idle' })
    expect(client.isRecording).toBe(false)
    client.dispose()
  })

  it('re-reads main status when stopRecording rejects so a retry stays possible', async () => {
    const { proxy } = createProxy()
    const failing: IBugRecorderService = {
      ...proxy,
      stopRecording: () => Promise.reject(new Error('disk full')),
    }
    const client = new BugRecorderClient(failing)
    await client.startRecording({})
    expect(client.isRecording).toBe(true)

    await expect(client.stopRecording({ redact: false })).rejects.toThrow('disk full')
    // Main keeps the recording alive when packing fails, so the client must not
    // flip itself to idle — that would hide the status bar entry the user needs
    // to retry the export, and drop every event recorded from then on.
    expect(client.isRecording).toBe(true)
    client.dispose()
  })

  it('falls back to idle when main cannot be reached after a failed stop', async () => {
    const { proxy } = createProxy()
    const failing: IBugRecorderService = {
      ...proxy,
      stopRecording: () => Promise.reject(new Error('disk full')),
      getRecordingStatus: () => Promise.reject(new Error('channel closed')),
    }
    const client = new BugRecorderClient(failing)
    await client.startRecording({})

    await expect(client.stopRecording({ redact: false })).rejects.toThrow('disk full')
    expect(client.isRecording).toBe(false)
    client.dispose()
  })

  it('forwards stop options, markStep and orphan calls to main', async () => {
    const { proxy, stopOptions, getMarkSteps, setOrphan } = createProxy()
    const client = new BugRecorderClient(proxy)
    await client.startRecording({ workspaceFolders: ['file:///w'] })

    await client.markStep()
    expect(getMarkSteps()).toBe(1)

    setOrphan({ startedAt: 1, eventCount: 2, screenshotCount: 0 })
    await expect(client.consumeOrphanRecording()).resolves.toEqual({
      startedAt: 1,
      eventCount: 2,
      screenshotCount: 0,
    })

    await client.stopRecording({ redact: true, transcripts: [{ title: 't', path: '/p.jsonl' }] })
    expect(stopOptions).toEqual([{ redact: true, transcripts: [{ title: 't', path: '/p.jsonl' }] }])
    client.dispose()
  })

  it('never surfaces a failed recordEvents call to the caller', async () => {
    const { proxy } = createProxy()
    const failing: IBugRecorderService = {
      ...proxy,
      recordEvents: () => Promise.reject(new Error('channel gone')),
    }
    const client = new BugRecorderClient(failing)
    await client.startRecording({})

    expect(() => client.recordEvent({ kind: 'marker' })).not.toThrow()
    await Promise.resolve()
    client.dispose()
  })
})
