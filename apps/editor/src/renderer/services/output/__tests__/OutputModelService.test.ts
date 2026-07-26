/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/output/OutputModelService.ts
 *  Runs in renderer-dom (needs the Monaco stub via MonacoLoader).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { LogLevel, type IStorageService } from '@universe-editor/platform'
import { OutputService } from '../OutputService.js'
import { OutputModelService } from '../OutputModelService.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
}

function makeServices(storage = makeStorage()) {
  const output = new OutputService(makeStorage())
  const models = new OutputModelService(output, storage)
  return { output, models, storage }
}

describe('OutputModelService', () => {
  it('acquireModel seeds the model with the channel text', () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    ch.append('hello\n')
    const model = models.acquireModel(ch)
    expect(model.getValue()).toBe('hello\n')
    expect(model.getLanguageId()).toBe('log')
  })

  it('acquireModel returns the same model instance on second call', () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    const m1 = models.acquireModel(ch)
    const m2 = models.acquireModel(ch)
    expect(m2).toBe(m1)
  })

  it('mirrors flushed appends into the model tail', async () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    const model = models.acquireModel(ch)

    ch.append('a\n')
    await flushMicrotasks()
    expect(model.getValue()).toBe('a\n')

    ch.appendLine('b')
    ch.appendLine('c')
    await flushMicrotasks()
    expect(model.getValue()).toBe('a\nb\nc\n')
  })

  it('an appender without a model stays lazy (no model created on append)', async () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    ch.append('x')
    await flushMicrotasks()
    expect(models.peekModel('main')).toBeUndefined()
  })

  it('clear empties the model', async () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    ch.append('data')
    const model = models.acquireModel(ch)
    ch.clear()
    expect(model.getValue()).toBe('')
  })

  it('model content stays identical to channel text across trims', async () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    const model = models.acquireModel(ch)
    // Push past the 4MB cap + 256KB slack so head trims kick in.
    for (let i = 0; i < 150_000; i++) {
      ch.appendLine(`entry-${i} with a reasonably long payload line`)
      if (i % 500 === 0) await flushMicrotasks()
    }
    await flushMicrotasks()
    expect(model.getValue()).toBe(ch.getText())
    expect(model.getValue().length).toBeLessThanOrEqual(4.5 * 1024 * 1024)
  }, 20_000)

  it('drops the model and view state when the channel is disposed', () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    const model = models.acquireModel(ch)
    models.saveViewState('main', { fake: true } as never)

    ch.dispose()
    expect(models.peekModel('main')).toBeUndefined()
    expect(models.getViewState('main')).toBeUndefined()
    expect(model.isDisposed()).toBe(true)
  })

  it('a same-named channel recreated after dispose gets a fresh model', () => {
    const { output, models } = makeServices()
    const a = output.createChannel('acp/claude/h1')
    a.append('old')
    const m1 = models.acquireModel(a)
    a.dispose()

    const b = output.createChannel('acp/claude/h1')
    const m2 = models.acquireModel(b)
    expect(m2).not.toBe(m1)
    expect(m2.getValue()).toBe('')
  })

  it('view state save/get round-trips', () => {
    const { models } = makeServices()
    const state = { scrollTop: 42 } as never
    models.saveViewState('main', state)
    expect(models.getViewState('main')).toBe(state)
    models.saveViewState('main', null)
    expect(models.getViewState('main')).toBeUndefined()
  })

  it('autoScroll defaults to true and flips via setAutoScroll', () => {
    const { models } = makeServices()
    expect(models.autoScroll.get()).toBe(true)
    models.setAutoScroll(false)
    expect(models.autoScroll.get()).toBe(false)
  })

  it('getHiddenRanges reflects level filters over the model content', () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    ch.append('[debug] d1\n[info] i1\n[error] e1\n')
    models.acquireModel(ch)

    expect(models.getHiddenRanges('main')).toEqual([])
    models.setLevelHidden(LogLevel.Debug, true)
    expect(models.getHiddenRanges('main')).toEqual([{ startLine: 1, endLineExclusive: 2 }])
    models.setLevelHidden(LogLevel.Debug, false)
    expect(models.getHiddenRanges('main')).toEqual([])
  })

  it('getHiddenRanges reflects the text filter and recomputes after flushes', async () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    ch.append('[info] alpha\n[info] beta\n')
    models.acquireModel(ch)

    models.setFilterText('alpha')
    expect(models.getHiddenRanges('main')).toEqual([{ startLine: 2, endLineExclusive: 4 }])

    ch.append('[info] alpha again\n')
    await flushMicrotasks()
    // Line 3 matches again; the trailing empty line stays hidden on its own.
    expect(models.getHiddenRanges('main')).toEqual([
      { startLine: 2, endLineExclusive: 3 },
      { startLine: 4, endLineExclusive: 5 },
    ])

    models.setFilterText('')
    expect(models.getHiddenRanges('main')).toEqual([])
  })

  it('attachHiddenAreas applies ranges through setHiddenAreas and refreshes on filter change', async () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    ch.append('[debug] d1\n[info] i1\n')
    models.acquireModel(ch)

    const applied: unknown[][] = []
    const fakeEditor = {
      setHiddenAreas: (ranges: unknown[]) => applied.push(ranges),
    }
    const d = models.attachHiddenAreas('main', fakeEditor as never)
    expect(d).toBeDefined()
    expect(applied).toEqual([[]])

    models.setLevelHidden(LogLevel.Debug, true)
    await flushMicrotasks()
    await new Promise((r) => setTimeout(r, 200))
    const last = applied[applied.length - 1] as Array<{
      startLineNumber: number
      endLineNumber: number
    }>
    // The debug entry and the trailing empty line hide as two ranges.
    expect(last.map((r) => [r.startLineNumber, r.endLineNumber])).toEqual([
      [1, 1],
      [3, 3],
    ])

    d?.dispose()
    applied.length = 0
    models.setLevelHidden(LogLevel.Debug, false)
    await new Promise((r) => setTimeout(r, 200))
    expect(applied).toEqual([])
  })

  it('attachHiddenAreas returns undefined when the editor lacks setHiddenAreas', () => {
    const { output, models } = makeServices()
    const ch = output.createChannel('main')
    models.acquireModel(ch)
    expect(models.attachHiddenAreas('main', {} as never)).toBeUndefined()
  })

  it('persists filter text and hidden levels to workspace storage', () => {
    const { models, storage } = makeServices()
    models.setFilterText('foo, !bar')
    models.setLevelHidden(LogLevel.Debug, true)
    models.setLevelHidden(LogLevel.Trace, true)

    expect(storage.set).toHaveBeenLastCalledWith(
      'output.filter',
      { filterText: 'foo, !bar', hiddenLevels: [LogLevel.Debug, LogLevel.Trace] },
      1, // StorageScope.WORKSPACE
    )
  })

  it('hydrates filter text and hidden levels from workspace storage', async () => {
    const storage = makeStorage()
    storage.get = vi.fn().mockResolvedValue({
      filterText: 'restored',
      hiddenLevels: [LogLevel.Warning, LogLevel.Error],
    })
    const { models } = makeServices(storage)
    await flushMicrotasks()

    expect(models.filterText.get()).toBe('restored')
    expect(models.hiddenLevels.get().has(LogLevel.Warning)).toBe(true)
    expect(models.hiddenLevels.get().has(LogLevel.Error)).toBe(true)
    expect(models.hiddenLevels.get().size).toBe(2)
  })

  it('ignores a malformed persisted filter and starts clean', async () => {
    const storage = makeStorage()
    storage.get = vi.fn().mockResolvedValue('not-an-object')
    const { models } = makeServices(storage)
    await flushMicrotasks()

    expect(models.filterText.get()).toBe('')
    expect(models.hiddenLevels.get().size).toBe(0)
  })

  it('user edits made before hydration resolves are not clobbered', async () => {
    const storage = makeStorage()
    let resolveGet: (value: unknown) => void = () => {}
    storage.get = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve
        }),
    )
    const { models } = makeServices(storage)
    models.setFilterText('typed early')
    models.setLevelHidden(LogLevel.Debug, true)

    resolveGet({ filterText: 'stale', hiddenLevels: [LogLevel.Error] })
    await flushMicrotasks()

    expect(models.filterText.get()).toBe('typed early')
    expect(models.hiddenLevels.get().has(LogLevel.Debug)).toBe(true)
    expect(models.hiddenLevels.get().has(LogLevel.Error)).toBe(false)
  })
})
