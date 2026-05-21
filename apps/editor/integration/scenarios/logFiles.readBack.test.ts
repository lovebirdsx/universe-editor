/*---------------------------------------------------------------------------------------------
 * Integration: LogFilesMainService reads logs written by LogMainService.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestWorkbench, type TestWorkbench } from '../fixtures/createTestWorkbench.js'

describe('logFiles.readBack (integration)', () => {
  let wb: TestWorkbench

  beforeEach(async () => {
    wb = await createTestWorkbench()
  })

  afterEach(async () => {
    await wb.dispose()
    vi.clearAllMocks()
  })

  it('lists and reads a log file written by LogMainService', async () => {
    const logger = wb.logService.createLogger({ id: 'integration', name: 'Integration' })
    logger.info('read me through log files service')
    logger.flush()

    await new Promise((r) => setTimeout(r, 250))

    const files = await wb.logFiles.listLogFiles()
    const file = files.find((candidate) => candidate.channelId === 'integration')
    expect(file).toBeDefined()

    const content = await wb.logFiles.readLogFile(file!.id)
    expect(content).toContain('read me through log files service')
  })
})
