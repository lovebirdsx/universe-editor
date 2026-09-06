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
    modelId: 'openai/openai-chat/gpt-4o',
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
    modelId: 'openai/openai-chat/gpt-4o',
    providerId: 'openai',
    protocol: 'openai-chat',
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
  return { service, onDidRecordRequest, onDidReplayChunk, onDidReplayEnd }
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

describe('AiDebugView — keyboard navigation', () => {
  afterEach(() => cleanup())

  const three = () => [
    summary({ id: 'a', responsePreview: 'first' }),
    summary({ id: 'b', responsePreview: 'second' }),
    summary({ id: 'c', responsePreview: 'third' }),
  ]

  const list = () => screen.getByRole('listbox')
  const selectedIds = () =>
    [...document.querySelectorAll<HTMLLIElement>('li[data-selected="true"]')].map(
      (el) => el.getAttribute('data-row-key') ?? '',
    )

  it('is a single focusable listbox, with rows as data rather than tab stops', async () => {
    const { service } = makeFakeService([summary()], fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getByTestId('ai-debug-row')).toBeTruthy())
    expect(list().getAttribute('tabindex')).toBe('0')
    expect(screen.getByTestId('ai-debug-row').hasAttribute('tabindex')).toBe(false)
  })

  it('landing focus on the list selects the first record and opens its detail', async () => {
    const { service } = makeFakeService(three(), fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getAllByTestId('ai-debug-row')).toHaveLength(3))
    expect(selectedIds()).toEqual([])

    fireEvent.focus(list())
    expect(selectedIds()).toEqual(['a'])
    // The detail pane is the intended consequence: fetching the record is the
    // same local read the user's next ArrowDown would have triggered anyway.
    await waitFor(() => expect(screen.getByTestId('ai-debug-detail')).toBeTruthy())
  })

  it('seeds the cursor once records arrive, if focus beat the IPC round-trip', async () => {
    // The realistic ordering for this view: clicking the AI Debug tab focuses the
    // list as soon as it mounts, which is before `listRecords()` resolves. The
    // seed has to survive that or the list looks unresponsive.
    let resolveRecords = (_: AiDebugRecordSummary[]) => {}
    const pending = new Promise<AiDebugRecordSummary[]>((r) => {
      resolveRecords = r
    })
    const { service } = makeFakeService([], fullRecord())
    service.listRecords = vi.fn(() => pending)
    renderView(service)

    await waitFor(() => expect(screen.getByTestId('ai-debug-empty')).toBeTruthy())
    fireEvent.focus(list())
    expect(selectedIds()).toEqual([])

    resolveRecords(three())
    await waitFor(() => expect(screen.getAllByTestId('ai-debug-row')).toHaveLength(3))
    // The deferred seed runs in a passive effect, so it commits one render after
    // the rows themselves appear — polling here rather than asserting inline
    // (rows present does not imply the seed has been applied yet).
    await waitFor(() => expect(selectedIds()).toEqual(['a']))
  })

  it('leaves an existing selection alone when focus returns', async () => {
    const { service } = makeFakeService(three(), fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getAllByTestId('ai-debug-row')).toHaveLength(3))

    fireEvent.keyDown(list(), { key: 'End' })
    expect(selectedIds()).toEqual(['c'])
    fireEvent.blur(list())
    fireEvent.focus(list())
    expect(selectedIds()).toEqual(['c'])
  })

  it('moves the selection with ArrowDown / ArrowUp — selection follows focus', async () => {
    const { service } = makeFakeService(three(), fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getAllByTestId('ai-debug-row')).toHaveLength(3))

    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(selectedIds()).toEqual(['a'])
    // The detail pane follows the cursor; there is no separate open action.
    await waitFor(() => expect(screen.getByTestId('ai-debug-detail')).toBeTruthy())

    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(selectedIds()).toEqual(['b'])
    fireEvent.keyDown(list(), { key: 'ArrowUp' })
    expect(selectedIds()).toEqual(['a'])
  })

  it('Home and End jump to the ends and clamp there', async () => {
    const { service } = makeFakeService(three(), fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getAllByTestId('ai-debug-row')).toHaveLength(3))

    fireEvent.keyDown(list(), { key: 'End' })
    expect(selectedIds()).toEqual(['c'])
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(selectedIds()).toEqual(['c'])
    fireEvent.keyDown(list(), { key: 'Home' })
    expect(selectedIds()).toEqual(['a'])
  })

  it('drops the cursor when a refresh loses the selected record', async () => {
    const records = three()
    const { service, onDidRecordRequest } = makeFakeService(records, fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getAllByTestId('ai-debug-row')).toHaveLength(3))
    fireEvent.keyDown(list(), { key: 'End' })
    expect(selectedIds()).toEqual(['c'])

    // The cursor is derived from selectedId, so a shrunken list cannot leave it
    // pointing at whatever slid into index 2.
    vi.mocked(service.listRecords).mockResolvedValue([records[0]!])
    onDidRecordRequest.fire(records[0]!)
    await waitFor(() => expect(screen.getAllByTestId('ai-debug-row')).toHaveLength(1))
    expect(selectedIds()).toEqual([])
  })

  it('lets Ctrl combinations through to the global keybinding handler', async () => {
    const { service } = makeFakeService(three(), fullRecord())
    renderView(service)
    await waitFor(() => expect(screen.getAllByTestId('ai-debug-row')).toHaveLength(3))
    fireEvent.keyDown(list(), { key: 'ArrowDown', ctrlKey: true })
    expect(selectedIds()).toEqual([])
  })
})
