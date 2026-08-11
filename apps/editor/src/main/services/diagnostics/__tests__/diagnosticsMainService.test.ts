/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/diagnostics/diagnosticsMainService.ts
 *--------------------------------------------------------------------------------------------*/

import AdmZip from 'adm-zip'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  promises as fsp,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
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

  function seedDump(name: string, content: string, mtime: Date) {
    const path = join(crashDir, name)
    writeFileSync(path, content)
    utimesSync(path, mtime, mtime)
    return path
  }

  it('consumeAbnormalExitReport returns the report once, then null', async () => {
    service.setAbnormalExitReport({
      previousSessionId: '20260803T010203',
      previousStartedAt: 1700000000000,
      previousLastAliveAt: 1700000090000,
      consecutiveAbnormalExits: 1,
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
    expect(md).toContain('App version: 9.9.9-test (release)')
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

  it('createDiagnosticsZip includes the injected process list in processes.txt', async () => {
    const withProcesses = new DiagnosticsMainService({
      crashDumpsDir: crashDir,
      logRoot,
      diagnosticsDir,
      mode: 'release',
      collectProcesses: () => Promise.resolve('main (1234)\n  renderer (5678)\n'),
    })
    try {
      const zip = new AdmZip(await withProcesses.createDiagnosticsZip())
      expect(zip.getEntries().map((e) => e.entryName)).toContain('processes.txt')
      expect(zip.readAsText('processes.txt')).toBe('main (1234)\n  renderer (5678)\n')
    } finally {
      withProcesses.dispose()
    }
  })

  it('createDiagnosticsZip degrades processes.txt when collectProcesses throws', async () => {
    const failing = new DiagnosticsMainService({
      crashDumpsDir: crashDir,
      logRoot,
      diagnosticsDir,
      mode: 'release',
      collectProcesses: () => Promise.reject(new Error('ps exploded')),
    })
    try {
      const zip = new AdmZip(await failing.createDiagnosticsZip())
      expect(zip.readAsText('processes.txt')).toBe('(process list unavailable)\n')
    } finally {
      failing.dispose()
    }
  })

  it('createDiagnosticsZip degrades processes.txt when collectProcesses is not injected', async () => {
    const zip = new AdmZip(await service.createDiagnosticsZip())
    expect(zip.readAsText('processes.txt')).toBe('(process list unavailable)\n')
  })

  it('createDiagnosticsZip packs the newest 2 dumps into crashes/ and annotates the listing', async () => {
    seedDump('oldest.dmp', 'old', new Date('2026-08-01T00:00:00Z'))
    seedDump('middle.dmp', 'mid', new Date('2026-08-02T00:00:00Z'))
    seedDump('newest.dmp', 'new', new Date('2026-08-03T00:00:00Z'))

    const zip = new AdmZip(await service.createDiagnosticsZip())
    const names = zip.getEntries().map((e) => e.entryName)
    expect(names).toContain('crashes/newest.dmp')
    expect(names).toContain('crashes/middle.dmp')
    expect(names).not.toContain('crashes/oldest.dmp')
    expect(zip.readAsText('crashes/newest.dmp')).toBe('new')

    const listing = zip.readAsText('crash-dumps.txt')
    expect(listing).toMatch(/newest\.dmp \(included\)/)
    expect(listing).toMatch(/middle\.dmp \(included\)/)
    expect(listing).toContain('oldest.dmp')
    expect(listing).not.toMatch(/oldest\.dmp \(/)
  })

  it('createDiagnosticsZip skips oversized dumps without consuming the pack quota', async () => {
    const capped = new DiagnosticsMainService({
      crashDumpsDir: crashDir,
      logRoot,
      diagnosticsDir,
      mode: 'release',
      crashDumpMaxBytes: 4,
    })
    try {
      seedDump('huge.dmp', 'way-too-big', new Date('2026-08-03T00:00:00Z'))
      seedDump('newer-small.dmp', 'bb', new Date('2026-08-02T00:00:00Z'))
      seedDump('older-small.dmp', 'aa', new Date('2026-08-01T00:00:00Z'))

      const zip = new AdmZip(await capped.createDiagnosticsZip())
      const names = zip.getEntries().map((e) => e.entryName)
      expect(names).not.toContain('crashes/huge.dmp')
      expect(names).toContain('crashes/newer-small.dmp')
      expect(names).toContain('crashes/older-small.dmp')

      const listing = zip.readAsText('crash-dumps.txt')
      expect(listing).toMatch(/huge\.dmp \(skipped: too large\)/)
      expect(listing).toMatch(/newer-small\.dmp \(included\)/)
      expect(listing).toMatch(/older-small\.dmp \(included\)/)
    } finally {
      capped.dispose()
    }
  })

  it('createDiagnosticsZip tolerates a dump that cannot be read', async () => {
    seedDump('gone.dmp', 'x', new Date('2026-08-03T00:00:00Z'))
    seedDump('ok.dmp', 'ok', new Date('2026-08-02T00:00:00Z'))
    const original = fsp.readFile
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation(((
      path: unknown,
      options?: unknown,
    ) => {
      if (String(path).endsWith('gone.dmp')) return Promise.reject(new Error('ENOENT'))
      return original.call(fsp, path as never, options as never)
    }) as typeof fsp.readFile)
    try {
      const zip = new AdmZip(await service.createDiagnosticsZip())
      const names = zip.getEntries().map((e) => e.entryName)
      expect(names).not.toContain('crashes/gone.dmp')
      expect(names).toContain('crashes/ok.dmp')
      expect(zip.readAsText('crash-dumps.txt')).toMatch(/ok\.dmp \(included\)/)
    } finally {
      spy.mockRestore()
    }
  })
})
