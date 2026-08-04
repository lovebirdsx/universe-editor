/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/diagnostics/diagnosticsMainService.ts
 *--------------------------------------------------------------------------------------------*/

import AdmZip from 'adm-zip'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const showItemInFolder = vi.fn()
const openPath = vi.fn().mockResolvedValue('')

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9-test',
    getLocale: () => 'zh-CN',
  },
  shell: {
    showItemInFolder: (...args: unknown[]) => showItemInFolder(...args),
    openPath: (...args: unknown[]) => openPath(...args),
  },
}))

const { DiagnosticsMainService } = await import('../diagnosticsMainService.js')

describe('DiagnosticsMainService', () => {
  let root: string
  let crashDir: string
  let logRoot: string
  let diagnosticsDir: string
  let service: InstanceType<typeof DiagnosticsMainService>

  beforeEach(() => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'diagnostics-test-'))
    crashDir = join(root, 'Crashes')
    logRoot = join(root, 'logs')
    diagnosticsDir = join(root, 'diagnostics')
    mkdirSync(crashDir, { recursive: true })
    service = new DiagnosticsMainService({
      crashDumpsDir: crashDir,
      logRoot,
      diagnosticsDir,
      mode: 'release',
      listExtensions: () =>
        Promise.resolve([{ id: 'pub.ext', version: '0.1.0', source: 'gallery' }]),
    })
  })

  afterEach(() => {
    service.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  function seedSession(session: string, errorsJsonl?: string, logs: Record<string, string> = {}) {
    const dir = join(logRoot, session)
    mkdirSync(dir, { recursive: true })
    if (errorsJsonl !== undefined) writeFileSync(join(dir, 'errors.jsonl'), errorsJsonl)
    for (const [name, content] of Object.entries(logs)) writeFileSync(join(dir, name), content)
  }

  it('consumeAbnormalExitReport returns the report once, then null', async () => {
    service.setAbnormalExitReport({
      previousSessionId: '20260803T010203',
      previousStartedAt: 1700000000000,
      crashDumps: ['C:\\dump\\a.dmp'],
    })
    const first = await service.consumeAbnormalExitReport()
    expect(first?.previousSessionId).toBe('20260803T010203')
    expect(first?.crashDumps).toHaveLength(1)
    expect(await service.consumeAbnormalExitReport()).toBeNull()
  })

  it('consumeAbnormalExitReport returns null when nothing was set', async () => {
    expect(await service.consumeAbnormalExitReport()).toBeNull()
  })

  it('revealCrashesFolder shows the newest dump when one exists', async () => {
    const dump = join(crashDir, 'abc-123.dmp')
    writeFileSync(dump, 'x')
    await service.revealCrashesFolder()
    expect(showItemInFolder).toHaveBeenCalledWith(dump)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('revealCrashesFolder falls back to opening the dir when no dumps exist', async () => {
    await service.revealCrashesFolder()
    expect(openPath).toHaveBeenCalledWith(crashDir)
  })

  it('collectIssueReport aggregates versions, extensions and error fingerprints', async () => {
    seedSession(
      '20260803T120000',
      JSON.stringify({
        v: 1,
        ts: 1,
        event: 'unhandledError',
        source: 'main',
        fingerprint: 'run@thing/doer.ts',
        count: 4,
        message: 'boom',
        sessionId: 's',
        appVersion: '9.9.9-test',
      }) + '\n',
    )
    const md = await service.collectIssueReport()
    expect(md).toContain('应用版本: 9.9.9-test (release)')
    expect(md).toContain('| pub.ext | 0.1.0 | gallery |')
    expect(md).toContain('| 4 | unhandledError | run@thing/doer.ts | main | boom |')
  })

  it('collectIssueReport only reads the most recent sessions', async () => {
    for (const session of ['20260801T000000', '20260802T000000', '20260803T000000']) {
      seedSession(
        session,
        JSON.stringify({
          v: 1,
          ts: 1,
          event: 'e',
          source: 'main',
          fingerprint: `fp-${session}@x.ts`,
          count: 1,
          message: session,
        }) + '\n',
      )
    }
    const md = await service.collectIssueReport()
    expect(md).toContain('fp-20260803T000000')
    expect(md).toContain('fp-20260802T000000')
    expect(md).not.toContain('fp-20260801T000000')
  })

  it('exportDiagnosticsZip writes a zip with sysinfo, errors, log tails and dump listing', async () => {
    seedSession(
      '20260803T120000',
      JSON.stringify({
        v: 1,
        ts: 1,
        event: 'e',
        source: 'main',
        fingerprint: 'f@x.ts',
        count: 1,
        message: 'm',
      }) + '\n',
      { 'main.log': 'main log line\n' },
    )
    const windowDir = join(logRoot, '20260803T120000', 'window-1')
    mkdirSync(windowDir, { recursive: true })
    writeFileSync(join(windowDir, 'renderer.log'), 'renderer log line\n')
    writeFileSync(join(crashDir, 'deadbeef.dmp'), 'dump')

    const zipPath = await service.exportDiagnosticsZip()
    expect(existsSync(zipPath)).toBe(true)
    expect(zipPath.startsWith(diagnosticsDir)).toBe(true)
    expect(showItemInFolder).toHaveBeenCalledWith(zipPath)

    const zip = new AdmZip(zipPath)
    const names = zip.getEntries().map((e) => e.entryName)
    expect(names).toContain('sysinfo.md')
    expect(names).toContain('errors-20260803T120000.jsonl')
    expect(names).toContain('logs/20260803T120000/main.log')
    expect(names).toContain('logs/20260803T120000/window-1/renderer.log')
    expect(names).toContain('crash-dumps.txt')
    const dumpListing = zip.readAsText('crash-dumps.txt')
    expect(dumpListing).toContain('deadbeef.dmp')
    expect(readFileSync(zipPath).length).toBeGreaterThan(0)
  })
})
