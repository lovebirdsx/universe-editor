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

async function writeLog(
  root: string,
  sessionId: string,
  name: string,
  content: string,
): Promise<void> {
  const dir = join(root, 'logs', sessionId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, name), content, 'utf8')
}

describe('LogFilesMainService', () => {
  let tmpDir: string
  let logService: InstanceType<typeof LogMainService>
  let service: InstanceType<typeof LogFilesMainService>
  let sessionId: string
  const WINDOW_ID = 7

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'ue-log-files-test-'))
    mockGetPath.mockReturnValue(tmpDir)
    logService = new LogMainService()
    service = new LogFilesMainService(logService, WINDOW_ID)
    sessionId = logService.getSessionId()
  })

  afterEach(async () => {
    logService.dispose()
    await fs.rm(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('returns an empty list when the current session directory does not exist', async () => {
    await expect(service.listLogFiles()).resolves.toEqual([])
  })

  it('lists .log files inside the current session as stable descriptors', async () => {
    await writeLog(tmpDir, sessionId, 'main.log', 'hello')

    const files = await service.listLogFiles()

    expect(files).toEqual([
      expect.objectContaining({
        id: `${sessionId}/main.log`,
        name: 'Main',
        channelId: 'main',
        sessionStartedAt: logService.getSessionStartedAt(),
        size: 5,
        modifiedTime: expect.any(Number),
      }),
    ])
  })

  it('does not surface log files from other sessions', async () => {
    await writeLog(tmpDir, sessionId, 'main.log', 'current')
    await writeLog(tmpDir, '20200101T000000', 'main.log', 'old')

    const files = await service.listLogFiles()

    expect(files).toHaveLength(1)
    expect(files[0]?.id).toBe(`${sessionId}/main.log`)
  })

  it('reads a small log file completely', async () => {
    await writeLog(tmpDir, sessionId, 'workspace.log', 'line one\nline two\n')

    await expect(service.readLogFile(`${sessionId}/workspace.log`)).resolves.toBe(
      'line one\nline two\n',
    )
  })

  it('reads only the tail of a large log file and marks it as truncated', async () => {
    await writeLog(tmpDir, sessionId, 'main.log', '0123456789')

    await expect(service.readLogFile(`${sessionId}/main.log`, 4)).resolves.toBe(
      '[Log truncated to last 4 bytes]\n6789',
    )
  })

  it('rejects invalid ids, path traversal, and non-log file names', async () => {
    await writeLog(tmpDir, sessionId, 'main.log', 'ok')
    await writeLog(tmpDir, sessionId, 'notes.txt', 'nope')

    await expect(service.readLogFile('main.log')).rejects.toThrow(/Invalid log file id/)
    await expect(service.readLogFile('../main.log')).rejects.toThrow(/Invalid log file id/)
    await expect(service.readLogFile(`${sessionId}/../main.log`)).rejects.toThrow(
      /Invalid log file id/,
    )
    await expect(service.readLogFile(`${sessionId}/notes.txt`)).rejects.toThrow(
      /Invalid log file id/,
    )
    // Legacy YYYY-MM-DD path segments must be rejected too
    await expect(service.readLogFile('2026-05-21/main.log')).rejects.toThrow(/Invalid log file id/)
  })

  it('opens the logs folder after ensuring it exists', async () => {
    await service.openLogsFolder()

    const root = join(tmpDir, 'logs')
    await expect(fs.stat(root)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
    expect(shell.openPath).toHaveBeenCalledWith(root)
  })

  it('drops the first partial line when tailing a large file to avoid mojibake', async () => {
    // Build a payload where the byte at offset (size - limit) lands in the middle
    // of a line and inside a multi-byte UTF-8 sequence.
    const head = '中文头部不应出现\n'.repeat(40) // ~ > 1KB of Chinese
    const tail = 'line A\nline B\n'
    await writeLog(tmpDir, sessionId, 'main.log', head + tail)

    const result = await service.readLogFile(`${sessionId}/main.log`, tail.length + 5)
    expect(result.startsWith('[Log truncated to last ')).toBe(true)
    // After truncation prefix, content should start at a line boundary
    const body = result.slice(result.indexOf('\n') + 1)
    expect(body).not.toContain('�')
    expect(body).toContain('line B')
  })

  it('uses the registered channel descriptor name when listing log files', async () => {
    // Register a channel with an explicit human-readable name
    logService.createLogger({ id: 'externalChange', name: 'External Change' })
    await writeLog(tmpDir, sessionId, 'externalChange.log', 'x')

    const files = await service.listLogFiles()
    const match = files.find((f) => f.channelId === 'externalChange')
    expect(match?.name).toBe('External Change')
  })

  it('setLogLevel updates the backing LogMainService level', async () => {
    await service.setLogLevel(LogLevel.Debug)

    expect(await service.getLogLevel()).toBe(LogLevel.Debug)
    expect(logService.getLevel()).toBe(LogLevel.Debug)
  })

  it('does not surface entries inside a rotated/ subdirectory as channels', async () => {
    await writeLog(tmpDir, sessionId, 'main.log', 'current')
    const rotatedDir = join(tmpDir, 'logs', sessionId, 'rotated')
    await fs.mkdir(rotatedDir, { recursive: true })
    await fs.writeFile(join(rotatedDir, 'main.2025-01-01T00-00-00-000Z.log'), 'old', 'utf8')

    const files = await service.listLogFiles()

    expect(files).toHaveLength(1)
    expect(files[0]?.channelId).toBe('main')
  })

  it('resolveLogPath returns the absolute fs path inside the logs root', async () => {
    await writeLog(tmpDir, sessionId, 'main.log', 'content')

    const path = await service.resolveLogPath(`${sessionId}/main.log`)

    expect(path).toBe(join(tmpDir, 'logs', sessionId, 'main.log'))
  })

  it('resolveLogPath rejects path traversal attempts', async () => {
    await expect(service.resolveLogPath('../etc/passwd')).rejects.toThrow(/Invalid log file id/)
  })

  it('forwards shared and own-window entries but drops other windows', async () => {
    const seen: number[] = []
    const sub = service.onDidAppendEntry((e) => {
      seen.push(e.windowId ?? -1)
    })

    logService.appendToChannel({ id: 'console', name: 'Console' }, LogLevel.Info, 'shared', 0)
    logService.appendToChannel(
      { id: 'console', name: 'Console' },
      LogLevel.Info,
      'mine',
      0,
      WINDOW_ID,
    )
    logService.appendToChannel(
      { id: 'console', name: 'Console' },
      LogLevel.Info,
      'theirs',
      0,
      WINDOW_ID + 1,
    )

    await new Promise((r) => setTimeout(r, 300))
    sub.dispose()
    expect(seen.sort()).toEqual([-1, WINDOW_ID])
  })

  it('lists this window-private channels alongside shared ones', async () => {
    await writeLog(tmpDir, sessionId, 'main.log', 'shared')
    const windowDir = join(tmpDir, 'logs', sessionId, `window-${WINDOW_ID}`)
    await fs.mkdir(windowDir, { recursive: true })
    await fs.writeFile(join(windowDir, 'console.log'), 'priv', 'utf8')

    const files = await service.listLogFiles()

    const ids = files.map((f) => f.id).sort()
    expect(ids).toContain(`${sessionId}/main.log`)
    expect(ids).toContain(`${sessionId}/window-${WINDOW_ID}/console.log`)
  })

  it('does not list other windows private channels', async () => {
    const otherDir = join(tmpDir, 'logs', sessionId, `window-${WINDOW_ID + 1}`)
    await fs.mkdir(otherDir, { recursive: true })
    await fs.writeFile(join(otherDir, 'console.log'), 'theirs', 'utf8')

    const files = await service.listLogFiles()

    expect(files).toEqual([])
  })

  it('suffixes the shared row with (Main) when a channelId collides with a private one', async () => {
    await writeLog(tmpDir, sessionId, 'console.log', 'shared')
    const windowDir = join(tmpDir, 'logs', sessionId, `window-${WINDOW_ID}`)
    await fs.mkdir(windowDir, { recursive: true })
    await fs.writeFile(join(windowDir, 'console.log'), 'priv', 'utf8')

    const files = await service.listLogFiles()

    const shared = files.find((f) => f.id === `${sessionId}/console.log`)
    const priv = files.find((f) => f.id === `${sessionId}/window-${WINDOW_ID}/console.log`)
    expect(shared?.name).toMatch(/\(Main\)$/)
    expect(priv?.name).not.toMatch(/\(Main\)$/)
  })

  it('reads and resolves a window-private log file by its 3-segment id', async () => {
    const windowDir = join(tmpDir, 'logs', sessionId, `window-${WINDOW_ID}`)
    await fs.mkdir(windowDir, { recursive: true })
    await fs.writeFile(join(windowDir, 'console.log'), 'private body\n', 'utf8')

    const id = `${sessionId}/window-${WINDOW_ID}/console.log`
    await expect(service.readLogFile(id)).resolves.toBe('private body\n')
    await expect(service.resolveLogPath(id)).resolves.toBe(join(windowDir, 'console.log'))
  })
})
