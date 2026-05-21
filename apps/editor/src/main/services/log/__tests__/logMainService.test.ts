/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/log/logMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogLevel } from '@universe-editor/platform'

// Mock electron's app before importing logMainService
const mockGetPath = vi.fn((_name: string): string => '')

vi.mock('electron', () => ({
  app: { getPath: mockGetPath },
}))

// Import after mock is set up
const { LogMainService } = await import('../logMainService.js')
const { MainLogChannelService } = await import('../mainLogChannelService.js')

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

  it('creates a logger that writes to a file', async () => {
    const svc = new LogMainService()
    const logger = svc.createLogger({ id: 'test', name: 'Test' })
    logger.info('hello from test')
    logger.flush()

    // Wait a bit for the async write
    await new Promise((r) => setTimeout(r, 200))

    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const logFile = join(tmpDir, 'logs', dateStr, 'test.log')
    const content = await fs.readFile(logFile, 'utf8')
    expect(content).toContain('hello from test')
    expect(content).toContain('[info]')
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

    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const logFile = join(tmpDir, 'logs', dateStr, 'filtered.log')
    // File should not exist (nothing written)
    await expect(fs.access(logFile)).rejects.toThrow()
  })

  it('cleanupOldLogs removes date directories older than the retention window', async () => {
    const svc = new LogMainService()
    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const recentDir = join(tmpDir, 'logs', dateStr)
    const oldDir = join(tmpDir, 'logs', '2000-01-01')
    await fs.mkdir(recentDir, { recursive: true })
    await fs.mkdir(oldDir, { recursive: true })
    await fs.writeFile(join(recentDir, 'main.log'), 'fresh', 'utf8')
    await fs.writeFile(join(oldDir, 'main.log'), 'stale', 'utf8')

    await svc.cleanupOldLogs(30)

    await expect(fs.access(recentDir)).resolves.toBeUndefined()
    await expect(fs.access(oldDir)).rejects.toThrow()
  })

  it('cleanupOldLogs is a no-op when the logs directory is missing', async () => {
    const svc = new LogMainService()
    await expect(svc.cleanupOldLogs(30)).resolves.toBeUndefined()
  })

  it('rotates oversized log files into a rotated/ subdirectory', async () => {
    const svc = new LogMainService()
    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const dayDir = join(tmpDir, 'logs', dateStr)
    await fs.mkdir(dayDir, { recursive: true })
    const logPath = join(dayDir, 'rotate-target.log')
    // Pre-populate the log file so rename has something to move
    await fs.writeFile(logPath, 'previous content', 'utf8')

    const logger = svc.createLogger({ id: 'rotate-target', name: 'Rotate Target' })
    // Force the FileLogger to think the file is oversized
    ;(logger as unknown as { _estimatedSize: number })._estimatedSize = 11 * 1024 * 1024
    logger.info('after-rotate line')
    logger.flush()
    await new Promise((r) => setTimeout(r, 200))

    const rotatedDir = join(dayDir, 'rotated')
    const rotatedEntries = await fs.readdir(rotatedDir)
    expect(rotatedEntries.some((name) => name.startsWith('rotate-target.'))).toBe(true)
    // New current log should still be at the un-rotated path
    const current = await fs.readFile(logPath, 'utf8')
    expect(current).toContain('after-rotate line')
  })

  it('fires onDidAppendEntry after a successful flush with the written chunk', async () => {
    const svc = new LogMainService()
    const events: Array<{ channelId: string; chunk: string }> = []
    svc.onDidAppendEntry((e) => events.push(e))

    const logger = svc.createLogger({ id: 'tail', name: 'Tail' })
    logger.info('first entry')
    logger.flush()
    await new Promise((r) => setTimeout(r, 200))

    expect(events).toHaveLength(1)
    expect(events[0]?.channelId).toBe('tail')
    expect(events[0]?.chunk).toContain('first entry')
    expect(events[0]?.chunk).toContain('[info]')
    // Chunk should end with a newline (line-terminated log entry)
    expect(events[0]?.chunk.endsWith('\n')).toBe(true)
  })

  it('does not fire onDidAppendEntry when no entries are queued', async () => {
    const svc = new LogMainService()
    const events: Array<{ channelId: string; chunk: string }> = []
    svc.onDidAppendEntry((e) => events.push(e))
    const logger = svc.createLogger({ id: 'idle', name: 'Idle' })
    logger.flush()
    await new Promise((r) => setTimeout(r, 200))
    expect(events).toHaveLength(0)
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
    const channelSvc = new MainLogChannelService(logSvc)

    const fireTime = Date.now()
    await channelSvc.append(42, 'editor', LogLevel.Info, 'renderer log entry', fireTime)

    // Wait for the async write
    await new Promise((r) => setTimeout(r, 200))
    logSvc.createLogger({ id: 'editor', name: 'Editor' }).flush()
    await new Promise((r) => setTimeout(r, 200))

    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const logFile = join(tmpDir, 'logs', dateStr, 'editor.log')
    const content = await fs.readFile(logFile, 'utf8')
    expect(content).toContain('[renderer:42] renderer log entry')
    // Timestamp recorded in the file matches the caller-supplied fire time
    expect(content).toContain(new Date(fireTime).toISOString())
  })

  it('appendBatch routes each entry to its channel with provenance prefix', async () => {
    const logSvc = new LogMainService()
    const channelSvc = new MainLogChannelService(logSvc)

    const ts = Date.now()
    await channelSvc.appendBatch(7, [
      { channel: 'editor', level: LogLevel.Info, message: 'one', timestamp: ts },
      { channel: 'workspace', level: LogLevel.Warning, message: 'two', timestamp: ts },
    ])

    await new Promise((r) => setTimeout(r, 200))
    logSvc.createLogger({ id: 'editor', name: 'Editor' }).flush()
    logSvc.createLogger({ id: 'workspace', name: 'Workspace' }).flush()
    await new Promise((r) => setTimeout(r, 200))

    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const editorContent = await fs.readFile(join(tmpDir, 'logs', dateStr, 'editor.log'), 'utf8')
    const workspaceContent = await fs.readFile(
      join(tmpDir, 'logs', dateStr, 'workspace.log'),
      'utf8',
    )
    expect(editorContent).toContain('[renderer:7] one')
    expect(workspaceContent).toContain('[renderer:7] two')
  })
})
