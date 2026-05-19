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
const { LogMainService, MainLogChannelService } = await import('../logMainService.js')

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

  it('routes append calls to the correct renderer log file', async () => {
    const logSvc = new LogMainService()
    const channelSvc = new MainLogChannelService(logSvc)

    await channelSvc.append(42, 'editor', LogLevel.Info, 'renderer log entry')

    // Wait for the async write
    await new Promise((r) => setTimeout(r, 200))
    logSvc.createLogger({ id: 'renderer-42', name: 'Renderer 42' }).flush()
    await new Promise((r) => setTimeout(r, 200))

    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const logFile = join(tmpDir, 'logs', dateStr, 'renderer-42.log')
    const content = await fs.readFile(logFile, 'utf8')
    expect(content).toContain('[editor] renderer log entry')
  })
})
