/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/log/logFilesMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shell } from 'electron'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogLevel } from '@universe-editor/platform'

const { mockGetPath, mockOpenPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn((_name: string): string => ''),
  mockOpenPath: vi.fn(async (_path: string): Promise<string> => ''),
}))

vi.mock('electron', () => ({
  app: { getPath: mockGetPath },
  shell: { openPath: mockOpenPath },
}))

const { LogMainService } = await import('../logMainService.js')
const { LogFilesMainService } = await import('../logFilesMainService.js')

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

async function writeLog(root: string, date: string, name: string, content: string): Promise<void> {
  const dir = join(root, 'logs', date)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, name), content, 'utf8')
}

describe('LogFilesMainService', () => {
  let tmpDir: string
  let logService: InstanceType<typeof LogMainService>
  let service: InstanceType<typeof LogFilesMainService>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'ue-log-files-test-'))
    mockGetPath.mockReturnValue(tmpDir)
    logService = new LogMainService()
    service = new LogFilesMainService(logService)
  })

  afterEach(async () => {
    logService.dispose()
    await fs.rm(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('returns an empty list when the logs directory does not exist', async () => {
    await expect(service.listLogFiles()).resolves.toEqual([])
  })

  it('lists date-scoped .log files as stable descriptors', async () => {
    const date = todayStr()
    await writeLog(tmpDir, date, 'main.log', 'hello')

    const files = await service.listLogFiles()

    expect(files).toEqual([
      expect.objectContaining({
        id: `${date}/main.log`,
        name: 'Main',
        channelId: 'main',
        date,
        size: 5,
        modifiedTime: expect.any(Number),
      }),
    ])
  })

  it('reads a small log file completely', async () => {
    const date = todayStr()
    await writeLog(tmpDir, date, 'workspace.log', 'line one\nline two\n')

    await expect(service.readLogFile(`${date}/workspace.log`)).resolves.toBe('line one\nline two\n')
  })

  it('reads only the tail of a large log file and marks it as truncated', async () => {
    const date = todayStr()
    await writeLog(tmpDir, date, 'main.log', '0123456789')

    await expect(service.readLogFile(`${date}/main.log`, 4)).resolves.toBe(
      '[Log truncated to last 4 bytes]\n6789',
    )
  })

  it('rejects invalid ids, path traversal, and non-log file names', async () => {
    const date = todayStr()
    await writeLog(tmpDir, date, 'main.log', 'ok')
    await writeLog(tmpDir, date, 'notes.txt', 'nope')

    await expect(service.readLogFile('main.log')).rejects.toThrow(/Invalid log file id/)
    await expect(service.readLogFile('../main.log')).rejects.toThrow(/Invalid log file id/)
    await expect(service.readLogFile(`${date}/../main.log`)).rejects.toThrow(/Invalid log file id/)
    await expect(service.readLogFile(`${date}/notes.txt`)).rejects.toThrow(/Invalid log file id/)
  })

  it('opens the logs folder after ensuring it exists', async () => {
    await service.openLogsFolder()

    const root = join(tmpDir, 'logs')
    await expect(fs.stat(root)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
    expect(shell.openPath).toHaveBeenCalledWith(root)
  })

  it('setLogLevel updates the backing LogMainService level', async () => {
    await service.setLogLevel(LogLevel.Debug)

    expect(await service.getLogLevel()).toBe(LogLevel.Debug)
    expect(logService.getLevel()).toBe(LogLevel.Debug)
  })
})
