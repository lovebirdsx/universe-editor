/*---------------------------------------------------------------------------------------------
 * Integration: LogMainService — error-to-disk chain
 * Tests that log messages written at various levels reach the correct log file on disk.
 * Verifies the integration between LogMainService and the real file system.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogLevel } from '@universe-editor/platform'
import { createTestWorkbench, type TestWorkbench } from '../fixtures/createTestWorkbench.js'

describe('notification.errorChain (integration)', () => {
  let wb: TestWorkbench

  beforeEach(async () => {
    wb = await createTestWorkbench()
  })

  afterEach(async () => {
    await wb.dispose()
    vi.clearAllMocks()
  })

  it('error() call reaches the log file on disk', async () => {
    const logger = wb.logService.createLogger({ id: 'test-error', name: 'TestError' })
    logger.error('something went wrong')
    logger.flush()

    await new Promise((r) => setTimeout(r, 250))

    const logFile = join(wb.userDataDir, 'logs', wb.logService.getSessionId(), 'test-error.log')
    const content = await fs.readFile(logFile, 'utf8')
    expect(content).toContain('something went wrong')
    expect(content).toContain('[error]')
  })

  it('multiple rapid errors are all flushed without loss', async () => {
    const logger = wb.logService.createLogger({ id: 'test-multi', name: 'TestMulti' })
    logger.error('error one')
    logger.error('error two')
    logger.error('error three')
    logger.flush()

    await new Promise((r) => setTimeout(r, 250))

    const logFile = join(wb.userDataDir, 'logs', wb.logService.getSessionId(), 'test-multi.log')
    const content = await fs.readFile(logFile, 'utf8')
    expect(content).toContain('error one')
    expect(content).toContain('error two')
    expect(content).toContain('error three')
  })

  it('setLevel filters out messages below threshold', async () => {
    wb.logService.setLevel(LogLevel.Error)
    const logger = wb.logService.createLogger({ id: 'test-filter', name: 'TestFilter' })
    logger.info('should be filtered')
    logger.error('should appear')
    logger.flush()

    await new Promise((r) => setTimeout(r, 250))

    const logFile = join(wb.userDataDir, 'logs', wb.logService.getSessionId(), 'test-filter.log')
    const content = await fs.readFile(logFile, 'utf8')
    expect(content).not.toContain('should be filtered')
    expect(content).toContain('should appear')
  })
})
