/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/log/logMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOG_TIMESTAMP_FORMAT_DEFAULT,
  LogLevel,
  formatLogTimestamp,
} from '@universe-editor/platform'

// Mock electron's app before importing logMainService
const mockGetPath = vi.fn((_name: string): string => '')

vi.mock('electron', () => ({
  app: { getPath: mockGetPath },
}))

// Import after mock is set up
const { LogMainService } = await import('../logMainService.js')
const { MainLogChannelService } = await import('../mainLogChannelService.js')

const SESSION_DIR_RE = /^\d{8}T\d{6}$/

// flush() is fire-and-forget (serialized through an async promise chain), so a
// fixed sleep after it is racy under load. Poll for the observable effect
// instead — once the last line is on disk, every prior flush's event has fired.
async function waitForFileContains(file: string, text: string): Promise<string> {
  let content = ''
  await vi.waitFor(
    async () => {
      content = await fs.readFile(file, 'utf8')
      expect(content).toContain(text)
    },
    { timeout: 5000, interval: 20 },
  )
  return content
}

async function waitForEvents(events: readonly unknown[], count: number): Promise<void> {
  await vi.waitFor(() => expect(events).toHaveLength(count), { timeout: 5000, interval: 20 })
}

describe('LogMainService', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'ue-log-test-'))
    mockGetPath.mockReturnValue(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('creates a logger that writes to a file under the current session directory', async () => {
    const svc = new LogMainService()
    const logger = svc.createLogger({ id: 'test', name: 'Test' })
    logger.info('hello from test')
    logger.flush()

    const sessionId = svc.getSessionId()
    expect(SESSION_DIR_RE.test(sessionId)).toBe(true)
    const logFile = join(tmpDir, 'logs', sessionId, 'test.log')
    const content = await waitForFileContains(logFile, 'hello from test')
    expect(content).toContain('[info]')
  })

  it('exposes a human-readable session start time', () => {
    const svc = new LogMainService()
    expect(svc.getSessionStartedAt()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('returns the same logger instance for the same channel id', () => {
    const svc = new LogMainService()
    const a = svc.createLogger({ id: 'chan', name: 'Chan' })
    const b = svc.createLogger({ id: 'chan', name: 'Chan' })
    expect(a).toBe(b)
  })

  it('creates independent loggers for different channel ids', () => {
    const svc = new LogMainService()
    const a = svc.createLogger({ id: 'chan-a', name: 'A' })
    const b = svc.createLogger({ id: 'chan-b', name: 'B' })
    expect(a).not.toBe(b)
  })

  it('setLevel propagates to all created loggers', () => {
    const svc = new LogMainService()
    const logger = svc.createLogger({ id: 'level-test', name: 'LevelTest' })
    svc.setLevel(LogLevel.Error)
    expect(logger.level).toBe(LogLevel.Error)
    expect(svc.getLevel()).toBe(LogLevel.Error)
  })

  it('level filter: logger below threshold does not write', async () => {
    const svc = new LogMainService()
    svc.setLevel(LogLevel.Error)
    const logger = svc.createLogger({ id: 'filtered', name: 'Filtered' })
    logger.debug('should not appear')
    logger.info('should not appear')
    logger.flush()

    await new Promise((r) => setTimeout(r, 200))

    const logFile = join(tmpDir, 'logs', svc.getSessionId(), 'filtered.log')
    await expect(fs.access(logFile)).rejects.toThrow()
  })

  it('cleanupOldLogs keeps the latest N session directories and drops the rest', async () => {
    const svc = new LogMainService()
    const logsRoot = join(tmpDir, 'logs')
    // Pre-create historical sessions older than the current one
    const old = ['20200101T000000', '20200102T000000', '20200103T000000']
    for (const name of old) {
      await fs.mkdir(join(logsRoot, name), { recursive: true })
      await fs.writeFile(join(logsRoot, name, 'main.log'), name, 'utf8')
    }
    // Ensure the current session directory also exists on disk
    await fs.mkdir(join(logsRoot, svc.getSessionId()), { recursive: true })

    // Retain only the 2 most recent sessions (current + one previous)
    await svc.cleanupOldLogs(2)

    const remaining = (await fs.readdir(logsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    expect(remaining).toContain(svc.getSessionId())
    expect(remaining).toContain('20200103T000000')
    expect(remaining).not.toContain('20200101T000000')
    expect(remaining).not.toContain('20200102T000000')
  })

  it('cleanupOldLogs always preserves the current session even past the retention count', async () => {
    const svc = new LogMainService()
    const logsRoot = join(tmpDir, 'logs')
    // Pre-create more recent sessions than the current one (current session is now)
    // To simulate this, just create newer-looking session dirs in the future
    const future = ['21000101T000000', '21000102T000000', '21000103T000000']
    for (const name of future) {
      await fs.mkdir(join(logsRoot, name), { recursive: true })
    }
    await fs.mkdir(join(logsRoot, svc.getSessionId()), { recursive: true })

    await svc.cleanupOldLogs(1)

    const remaining = (await fs.readdir(logsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
    expect(remaining).toContain(svc.getSessionId())
  })

  it('cleanupOldLogs removes legacy date-format directories', async () => {
    const svc = new LogMainService()
    const logsRoot = join(tmpDir, 'logs')
    await fs.mkdir(join(logsRoot, '2026-05-21'), { recursive: true })
    await fs.writeFile(join(logsRoot, '2026-05-21', 'main.log'), 'legacy', 'utf8')
    await fs.mkdir(join(logsRoot, svc.getSessionId()), { recursive: true })

    await svc.cleanupOldLogs(20)

    await expect(fs.access(join(logsRoot, '2026-05-21'))).rejects.toThrow()
    await expect(fs.access(join(logsRoot, svc.getSessionId()))).resolves.toBeUndefined()
  })

  it('cleanupOldLogs is a no-op when the logs directory is missing', async () => {
    const svc = new LogMainService()
    await expect(svc.cleanupOldLogs(20)).resolves.toBeUndefined()
  })

  it('rotates oversized log files into a rotated/ subdirectory under the session', async () => {
    const svc = new LogMainService()
    const sessionDir = join(tmpDir, 'logs', svc.getSessionId())
    await fs.mkdir(sessionDir, { recursive: true })
    const logPath = join(sessionDir, 'rotate-target.log')
    await fs.writeFile(logPath, 'previous content', 'utf8')

    const logger = svc.createLogger({ id: 'rotate-target', name: 'Rotate Target' })
    ;(logger as unknown as { _estimatedSize: number })._estimatedSize = 11 * 1024 * 1024
    logger.info('after-rotate line')
    logger.flush()
    // Rotation precedes the append within the same flush, so once the new line
    // is on disk the rotated/ entry is guaranteed to exist.
    const current = await waitForFileContains(logPath, 'after-rotate line')

    const rotatedDir = join(sessionDir, 'rotated')
    const rotatedEntries = await fs.readdir(rotatedDir)
    expect(rotatedEntries.some((name) => name.startsWith('rotate-target.'))).toBe(true)
    expect(current).toContain('after-rotate line')
  })

  it('suppresses onDidAppendEntry fan-out after a rotate burst (feedback-loop circuit breaker)', async () => {
    const svc = new LogMainService()
    const events: Array<{ channelId: string }> = []
    svc.onDidAppendEntry((e) => events.push(e))

    const logger = svc.createLogger({ id: 'burst', name: 'Burst' })
    const inner = logger as unknown as { _estimatedSize: number }
    const logFile = join(tmpDir, 'logs', svc.getSessionId(), 'burst.log')

    // Force enough back-to-back rotations to exceed the burst threshold. Each
    // flush is pushed over the size cap so _rotate() runs and records a rotation.
    // Wait for each line to land before enqueueing the next — otherwise all
    // lines coalesce into a single flush and only one rotation is recorded.
    for (let i = 0; i < 4; i++) {
      inner._estimatedSize = 11 * 1024 * 1024
      logger.info(`line ${i}`)
      logger.flush()
      await waitForFileContains(logFile, `line ${i}`)
    }
    const countAfterBurst = events.length
    expect(countAfterBurst).toBeGreaterThan(0)

    // A subsequent normal write must NOT fan out while suppression is active,
    // even though the file itself keeps recording.
    inner._estimatedSize = 0
    logger.info('post-burst line')
    logger.flush()

    const current = await waitForFileContains(logFile, 'post-burst line')
    expect(events.length).toBe(countAfterBurst)
    expect(current).toContain('post-burst line')
  })

  it('fires onDidAppendEntry after a successful flush with the written chunk', async () => {
    const svc = new LogMainService()
    const events: Array<{ channelId: string; chunk: string; maxLevel: LogLevel }> = []
    svc.onDidAppendEntry((e) => events.push(e))

    const logger = svc.createLogger({ id: 'tail', name: 'Tail' })
    logger.info('first entry')
    logger.flush()
    await waitForEvents(events, 1)
    expect(events[0]?.channelId).toBe('tail')
    expect(events[0]?.chunk).toContain('first entry')
    expect(events[0]?.chunk).toContain('[info]')
    expect(events[0]?.chunk.endsWith('\n')).toBe(true)
    expect(events[0]?.maxLevel).toBe(LogLevel.Info)
  })

  it('reports the highest log level in each append event', async () => {
    const svc = new LogMainService()
    const events: Array<{ channelId: string; chunk: string; maxLevel: LogLevel }> = []
    svc.onDidAppendEntry((e) => events.push(e))

    const logger = svc.createLogger({ id: 'levels', name: 'Levels' })
    logger.warn('warning entry')
    logger.error('error entry')
    logger.flush()
    await waitForEvents(events, 1)
    expect(events[0]?.channelId).toBe('levels')
    expect(events[0]?.chunk).toContain('[warn] warning entry')
    expect(events[0]?.chunk).toContain('[error] error entry')
    expect(events[0]?.maxLevel).toBe(LogLevel.Error)
  })

  it('does not fire onDidAppendEntry when no entries are queued', async () => {
    const svc = new LogMainService()
    const events: Array<{ channelId: string; chunk: string; maxLevel: LogLevel }> = []
    svc.onDidAppendEntry((e) => events.push(e))
    const logger = svc.createLogger({ id: 'idle', name: 'Idle' })
    logger.flush()
    await new Promise((r) => setTimeout(r, 200))
    expect(events).toHaveLength(0)
  })

  it('error entries are written immediately, ahead of the flush debounce', async () => {
    const svc = new LogMainService()
    const logger = svc.createLogger({ id: 'immediate', name: 'Immediate' })
    logger.error('boom')

    // Well inside the 150ms debounce window: only an immediate flush can have
    // written the file by now.
    await new Promise((r) => setTimeout(r, 60))

    const logFile = join(tmpDir, 'logs', svc.getSessionId(), 'immediate.log')
    const content = await fs.readFile(logFile, 'utf8')
    expect(content).toContain('[error] boom')
  })

  it('an immediate error flush does not reorder earlier debounced entries', async () => {
    const svc = new LogMainService()
    const logger = svc.createLogger({ id: 'ordered', name: 'Ordered' })
    logger.info('first info')
    logger.error('then error')

    const logFile = join(tmpDir, 'logs', svc.getSessionId(), 'ordered.log')
    const content = await waitForFileContains(logFile, 'then error')
    expect(content.indexOf('first info')).toBeGreaterThanOrEqual(0)
    expect(content.indexOf('first info')).toBeLessThan(content.indexOf('then error'))
  })
})

describe('MainLogChannelService', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'ue-log-channel-test-'))
    mockGetPath.mockReturnValue(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('routes append calls to the channel-named log file with renderer provenance prefix', async () => {
    const logSvc = new LogMainService()
    const channelSvc = new MainLogChannelService(logSvc, 42)

    const fireTime = Date.now()
    await channelSvc.append('editor', LogLevel.Info, 'renderer log entry', fireTime)

    const logFile = join(tmpDir, 'logs', logSvc.getSessionId(), 'window-42', 'editor.log')
    const content = await waitForFileContains(logFile, 'renderer log entry')
    expect(content).toContain('[renderer:42] renderer log entry')
    expect(content).toContain(formatLogTimestamp(new Date(fireTime), LOG_TIMESTAMP_FORMAT_DEFAULT))
  })

  it('appendBatch routes each entry to its channel with provenance prefix', async () => {
    const logSvc = new LogMainService()
    const channelSvc = new MainLogChannelService(logSvc, 7)

    const ts = Date.now()
    await channelSvc.appendBatch([
      { channel: 'editor', level: LogLevel.Info, message: 'one', timestamp: ts },
      { channel: 'workspace', level: LogLevel.Warning, message: 'two', timestamp: ts },
    ])

    const sessionId = logSvc.getSessionId()
    const windowDir = join(tmpDir, 'logs', sessionId, 'window-7')
    const editorContent = await waitForFileContains(join(windowDir, 'editor.log'), 'one')
    const workspaceContent = await waitForFileContains(join(windowDir, 'workspace.log'), 'two')
    expect(editorContent).toContain('[renderer:7] one')
    expect(workspaceContent).toContain('[renderer:7] two')
  })
})
