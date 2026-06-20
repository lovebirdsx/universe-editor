/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for AiDebugView — renders recorded requests, shows the selected record's
 *  detail, and triggers offline replay through IAiDebugService.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Emitter, InstantiationService, ServiceCollection } from '@universe-editor/platform'
import type { AiDebugRecord, AiDebugRecordSummary } from '@universe-editor/platform'
import { AiDebugView } from '../AiDebugView.js'
import { IAiDebugService } from '../../../../shared/ipc/aiDebugService.js'
import type {
  AiReplayChunkEvent,
  AiReplayEndEvent,
  IAiDebugService as IAiDebugServiceType,
} from '../../../../shared/ipc/aiDebugService.js'
import { ServicesContext } from '../../useService.js'

function summary(over?: Partial<AiDebugRecordSummary>): AiDebugRecordSummary {
  return {
    id: 'rec1',
    purpose: 'inline-completion',
    modelId: 'openai/default/gpt-4o',
    startedAt: 0,
    durationMs: 123,
    status: 'ok',
    responsePreview: 'Hello world',
    tokens: { inputTokens: 12, outputTokens: 48 },
    ...over,
  }
}

function fullRecord(over?: Partial<AiDebugRecord>): AiDebugRecord {
  return {
    id: 'rec1',
    requestId: 'req1',
    purpose: 'inline-completion',
    modelId: 'openai/default/gpt-4o',
    vendor: 'openai',
    groupName: 'default',
    startedAt: 0,
    endedAt: 123,
    durationMs: 123,
    status: 'ok',
    messages: [{ role: 1, text: 'say hi' }],
    options: {},
    responseText: 'Hello world',
    usage: { inputTokens: 12, outputTokens: 48 },
    chunks: [{ atMs: 1, chunk: { type: 'text', value: 'Hello world' } }],
    ...over,
  }
}

function makeFakeService(records: AiDebugRecordSummary[], record: AiDebugRecord) {
  const onDidRecordRequest = new Emitter<AiDebugRecordSummary>()
  const onDidClear = new Emitter<void>()
  const onDidReplayChunk = new Emitter<AiReplayChunkEvent>()
  const onDidReplayEnd = new Emitter<AiReplayEndEvent>()
  const service: IAiDebugServiceType = {
    _serviceBrand: undefined,
    onDidRecordRequest: onDidRecordRequest.event,
    onDidClear: onDidClear.event,
    onDidReplayChunk: onDidReplayChunk.event,
    onDidReplayEnd: onDidReplayEnd.event,
    listRecords: vi.fn(() => Promise.resolve(records)),
    getRecord: vi.fn(() => Promise.resolve(record)),
    clearRecords: vi.fn(() => Promise.resolve()),
    isEnabled: vi.fn(() => Promise.resolve(true)),
    setEnabled: vi.fn(() => Promise.resolve()),
    replayRecord: vi.fn(() => Promise.resolve('replay1')),
  }
  return { service, onDidReplayChunk, onDidReplayEnd }
}

function renderView(service: IAiDebugServiceType) {
  const services = new ServiceCollection()
  services.set(IAiDebugService, service)
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <AiDebugView />
    </ServicesContext.Provider>,
  )
}

describe('AiDebugView', () => {
  afterEach(() => cleanup())

  it('lists recorded requests', async () => {
    const { service } = makeFakeService([summary()], fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getByTestId('ai-debug-row')).toBeTruthy())
    expect(screen.getByText('Hello world')).toBeTruthy()
  })

  it('shows an empty state when there are no records', async () => {
    const { service } = makeFakeService([], fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getByTestId('ai-debug-empty')).toBeTruthy())
  })

  it('opens the detail of a selected record', async () => {
    const { service } = makeFakeService([summary()], fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getByTestId('ai-debug-row')).toBeTruthy())
    fireEvent.click(screen.getByTestId('ai-debug-row'))
    await waitFor(() => expect(screen.getByTestId('ai-debug-detail')).toBeTruthy())
    expect(screen.getByText('say hi')).toBeTruthy()
  })

  it('replays a record and renders streamed mock output', async () => {
    const { service, onDidReplayChunk, onDidReplayEnd } = makeFakeService([summary()], fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getByTestId('ai-debug-row')).toBeTruthy())
    fireEvent.click(screen.getByTestId('ai-debug-row'))
    await waitFor(() => expect(screen.getByTestId('ai-debug-replay')).toBeTruthy())
    fireEvent.click(screen.getByTestId('ai-debug-replay'))

    await waitFor(() => expect(service.replayRecord).toHaveBeenCalled())
    onDidReplayChunk.fire({ replayId: 'replay1', chunk: { type: 'text', value: 'mocked' } })
    onDidReplayEnd.fire({ replayId: 'replay1' })

    await waitFor(() =>
      expect(screen.getByTestId('ai-debug-replay-output').textContent).toBe('mocked'),
    )
  })

  it('clears records', async () => {
    const { service } = makeFakeService([summary()], fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getByTestId('ai-debug-clear')).toBeTruthy())
    fireEvent.click(screen.getByTestId('ai-debug-clear'))
    expect(service.clearRecords).toHaveBeenCalled()
  })
})
