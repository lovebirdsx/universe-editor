/*---------------------------------------------------------------------------------------------
 *  Tests for DisposableLeakMainService — atomic file IO + ENOENT tolerance.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOriginalConsole } from '@universe-editor/platform'
import { DisposableLeakMainService } from '../disposableLeakMainService.js'
import type { IDisposableLeakReport } from '../../../../shared/ipc/services.js'

const SAMPLE: IDisposableLeakReport = {
  count: 3,
  details: '[Leak #1] idx=0\n at foo',
  capturedAt: 1700000000000,
  source: 'unknown',
}

describe('DisposableLeakMainService', () => {
  let dir: string
  let filePath: string
  let svc: DisposableLeakMainService
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ue-leak-'))
    filePath = join(dir, 'last-disposable-leak.json')
    svc = new DisposableLeakMainService(filePath)
    warnSpy = vi.spyOn(getOriginalConsole(), 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    warnSpy.mockRestore()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('consumePendingReport returns null when no file exists', async () => {
    expect(await svc.consumePendingReport()).toBeNull()
  })

  it('reportLeaks writes the file and consumePendingReport reads it back', async () => {
    await svc.reportLeaks(SAMPLE)
    const read = await svc.consumePendingReport()
    expect(read).toEqual(SAMPLE)
  })

  it('consumePendingReport deletes the file after reading', async () => {
    await svc.reportLeaks(SAMPLE)
    expect(await svc.consumePendingReport()).not.toBeNull()
    expect(await svc.consumePendingReport()).toBeNull()
  })

  it('returns null for malformed file content', async () => {
    await fs.writeFile(filePath, 'not json', 'utf8')
    expect(await svc.consumePendingReport()).toBeNull()
  })

  it('returns null for JSON missing required fields', async () => {
    await fs.writeFile(filePath, JSON.stringify({ foo: 1 }), 'utf8')
    expect(await svc.consumePendingReport()).toBeNull()
  })

  it('reportLeaks serializes concurrent writes (last write wins)', async () => {
    const a: IDisposableLeakReport = { ...SAMPLE, count: 1 }
    const b: IDisposableLeakReport = { ...SAMPLE, count: 2 }
    const c: IDisposableLeakReport = { ...SAMPLE, count: 3 }
    await Promise.all([svc.reportLeaks(a), svc.reportLeaks(b), svc.reportLeaks(c)])
    const read = await svc.consumePendingReport()
    expect(read?.count).toBe(3)
  })

  it('reportLeaks prints a terminal-visible warning with source, count and details', async () => {
    await svc.reportLeaks({ ...SAMPLE, source: 'close', count: 2 })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? '')
    expect(msg).toContain('[renderer:close]')
    expect(msg).toContain('2 Disposable leak(s)')
    expect(msg).toContain(SAMPLE.details)
  })

  it('reportLeaks creates parent directory if missing', async () => {
    const nested = join(dir, 'nested', 'a', 'b', 'leak.json')
    const nestedSvc = new DisposableLeakMainService(nested)
    await nestedSvc.reportLeaks(SAMPLE)
    expect(await nestedSvc.consumePendingReport()).toEqual(SAMPLE)
  })
})
