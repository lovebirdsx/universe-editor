/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/AggregatedLogChannelContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  IOutputService,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  type IStorageService,
} from '@universe-editor/platform'
import { ILogFilesService, type LogAppendEvent } from '../../../shared/ipc/services.js'
import { OutputService } from '../../services/output/OutputService.js'
import {
  AggregatedLogChannelContribution,
  AGGREGATED_LOG_CHANNEL_NAME,
} from '../AggregatedLogChannelContribution.js'

interface FakeLogFilesService {
  _serviceBrand: undefined
  listLogFiles: ReturnType<typeof vi.fn>
  readLogFile: ReturnType<typeof vi.fn>
  resolveLogPath: ReturnType<typeof vi.fn>
  openLogsFolder: ReturnType<typeof vi.fn>
  setLogLevel: ReturnType<typeof vi.fn>
  getLogLevel: ReturnType<typeof vi.fn>
  setTimestampFormat: ReturnType<typeof vi.fn>
  getTimestampFormat: ReturnType<typeof vi.fn>
  onDidAppendEntry: Emitter<LogAppendEvent>['event']
  _emitter: Emitter<LogAppendEvent>
}

function makeLogFiles(
  descriptors: Array<{ name: string; channelId: string }>,
): FakeLogFilesService {
  const emitter = new Emitter<LogAppendEvent>()
  return {
    _serviceBrand: undefined,
    listLogFiles: vi.fn().mockResolvedValue(
      descriptors.map((d) => ({
        id: `20260521T100000/${d.channelId}.log`,
        name: d.name,
        channelId: d.channelId,
        sessionStartedAt: '2026-05-21 10:00:00',
        size: 0,
        modifiedTime: 0,
      })),
    ),
    readLogFile: vi.fn(),
    resolveLogPath: vi.fn(),
    openLogsFolder: vi.fn(),
    setLogLevel: vi.fn(),
    getLogLevel: vi.fn(),
    setTimestampFormat: vi.fn(),
    getTimestampFormat: vi.fn(),
    onDidAppendEntry: emitter.event,
    _emitter: emitter,
  }
}

function fireAppend(
  logFiles: FakeLogFilesService,
  channelId: string,
  chunk: string,
  maxLevel: LogLevel = LogLevel.Info,
): void {
  logFiles._emitter.fire({ channelId, chunk, maxLevel })
}

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

function instantiate(
  output: OutputService,
  logFiles: FakeLogFilesService,
): AggregatedLogChannelContribution {
  const services = new ServiceCollection()
  services.set(ILogFilesService, logFiles as never)
  services.set(IOutputService, output)
  const inst = new InstantiationService(services)
  return inst.createInstance(AggregatedLogChannelContribution)
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AggregatedLogChannelContribution', () => {
  let output: OutputService
  let logFiles: FakeLogFilesService

  beforeEach(() => {
    output = new OutputService(makeStorage())
    logFiles = makeLogFiles([
      { name: 'Main', channelId: 'main' },
      { name: 'Console', channelId: 'console' },
      { name: 'Editor', channelId: 'editor' },
    ])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates the All channel on construction', async () => {
    const contribution = instantiate(output, logFiles)
    try {
      const channel = output.getChannel(AGGREGATED_LOG_CHANNEL_NAME)
      expect(channel).toBeDefined()
      expect(channel?.kind).toBe('aggregated')
    } finally {
      contribution.dispose()
    }
  })

  it('prefixes complete lines with the channel name and appends to All in arrival order', async () => {
    const contribution = instantiate(output, logFiles)
    await flush()

    const all = output.getChannel(AGGREGATED_LOG_CHANNEL_NAME)!
    fireAppend(logFiles, 'main', 'm1\n')
    fireAppend(logFiles, 'console', 'c1\n')
    fireAppend(logFiles, 'main', 'm2\n')

    expect(all.content.get()).toBe('[Main] m1\n[Console] c1\n[Main] m2\n')
    contribution.dispose()
  })

  it('buffers partial lines across multiple chunks until a newline arrives', async () => {
    const contribution = instantiate(output, logFiles)
    await flush()

    const all = output.getChannel(AGGREGATED_LOG_CHANNEL_NAME)!
    fireAppend(logFiles, 'main', 'part-')
    expect(all.content.get()).toBe('')
    expect(contribution._getTail('main')).toBe('part-')

    fireAppend(logFiles, 'main', 'rest\n')
    expect(all.content.get()).toBe('[Main] part-rest\n')
    expect(contribution._getTail('main')).toBe('')

    contribution.dispose()
  })

  it('flushes only up to the last newline, keeping trailing partial in the tail', async () => {
    const contribution = instantiate(output, logFiles)
    await flush()

    const all = output.getChannel(AGGREGATED_LOG_CHANNEL_NAME)!
    fireAppend(logFiles, 'main', 'a\nb\nc')
    expect(all.content.get()).toBe('[Main] a\n[Main] b\n')
    expect(contribution._getTail('main')).toBe('c')

    fireAppend(logFiles, 'main', '\n')
    expect(all.content.get()).toBe('[Main] a\n[Main] b\n[Main] c\n')
    contribution.dispose()
  })

  it('clears tail buffers when the All channel is cleared', async () => {
    const contribution = instantiate(output, logFiles)
    await flush()

    const all = output.getChannel(AGGREGATED_LOG_CHANNEL_NAME)!
    fireAppend(logFiles, 'main', 'a\npartial')
    expect(contribution._getTail('main')).toBe('partial')

    all.clear()
    // autorun runs synchronously on the next observable read; force it by reading
    await flush()
    expect(contribution._getTail('main')).toBe('')

    // After clear, a fresh chunk should not be concatenated onto the dropped tail.
    fireAppend(logFiles, 'main', 'fresh\n')
    expect(all.content.get()).toBe('[Main] fresh\n')

    contribution.dispose()
  })

  it('falls back to humanized channelId when the descriptor is missing', async () => {
    // Simulate the race where a chunk arrives before listLogFiles() has the
    // corresponding .log file on disk (e.g. console.log not yet flushed).
    logFiles.listLogFiles.mockResolvedValueOnce([])
    const contribution = instantiate(output, logFiles)
    await flush()

    const all = output.getChannel(AGGREGATED_LOG_CHANNEL_NAME)!
    // 'main' and 'console' are in the humanizeChannelId KNOWN_LABELS map so
    // they resolve to 'Main' / 'Console' even without a descriptor.
    fireAppend(logFiles, 'main', 'first\n')
    fireAppend(logFiles, 'console', 'hello\n')
    expect(all.content.get()).toBe('[Main] first\n[Console] hello\n')

    fireAppend(logFiles, 'main', 'second\n')
    expect(all.content.get()).toBe('[Main] first\n[Console] hello\n[Main] second\n')
    contribution.dispose()
  })

  it('stops appending after dispose', async () => {
    const contribution = instantiate(output, logFiles)
    await flush()
    const all = output.getChannel(AGGREGATED_LOG_CHANNEL_NAME)!
    contribution.dispose()

    fireAppend(logFiles, 'main', 'after\n')
    expect(all.content.get()).toBe('')
  })
})
