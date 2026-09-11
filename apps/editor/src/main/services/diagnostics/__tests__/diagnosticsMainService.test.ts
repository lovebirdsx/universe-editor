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
import { AbstractLogger, LogLevel, type ILoggerService } from '@universe-editor/platform'
import type { WireRendererHeapSample } from '../../../../shared/ipc/services.js'

declare const __APP_VERSION__: string

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

const { DiagnosticsMainService, createWindowScopedDiagnostics, formatRendererHeapSample } =
  await import('../diagnosticsMainService.js')

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
    expect(md).toContain(`App version: ${__APP_VERSION__} (release)`)
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

  it('createDiagnosticsZip packs the main-side IPC frame record', async () => {
    // The renderer that OOMs mid-frame cannot report what it was decoding; main can,
    // and this file is where that answer has to survive into the bundle.
    const withFrames = new DiagnosticsMainService({
      crashDumpsDir: crashDir,
      logRoot,
      diagnosticsDir,
      mode: 'release',
      readIpcFrames: () =>
        'frames seen=3 largest=120MB\n1234ms out 120MB request channel=fileSearch cmd=findFiles',
    })
    try {
      const zip = new AdmZip(await withFrames.createDiagnosticsZip())
      const text = zip.readAsText('ipc-frames.txt')
      expect(text).toContain('seen=3')
      expect(text).toContain('cmd=findFiles')
    } finally {
      withFrames.dispose()
    }
  })

  it('createDiagnosticsZip degrades ipc-frames.txt rather than omitting it', async () => {
    // A missing attachment reads as "nothing to see"; an explicit placeholder reads
    // as "this build could not tell you", which is a different conclusion.
    const zip = new AdmZip(await service.createDiagnosticsZip())
    expect(zip.getEntries().map((e) => e.entryName)).toContain('ipc-frames.txt')
    expect(zip.readAsText('ipc-frames.txt')).toBe('(ipc frame record unavailable)\n')
  })

  it('createDiagnosticsZip packs the injected memory snapshot', async () => {
    const withMemory = new DiagnosticsMainService({
      crashDumpsDir: crashDir,
      logRoot,
      diagnosticsDir,
      mode: 'release',
      collectMemory: () =>
        Promise.resolve(
          'main-heap heapUsed=200MB\nhosted-processes cnt=2 extension-host#77=3800MB\n',
        ),
    })
    try {
      const zip = new AdmZip(await withMemory.createDiagnosticsZip())
      expect(zip.readAsText('memory.txt')).toContain('extension-host#77=3800MB')
    } finally {
      withMemory.dispose()
    }
  })

  it('createDiagnosticsZip degrades memory.txt when collectMemory throws', async () => {
    const failing = new DiagnosticsMainService({
      crashDumpsDir: crashDir,
      logRoot,
      diagnosticsDir,
      mode: 'release',
      collectMemory: () => Promise.reject(new Error('tasklist exploded')),
    })
    try {
      const zip = new AdmZip(await failing.createDiagnosticsZip())
      // Containment, not equality: the degraded snapshot still carries the renderer heap
      // tail, and a build that can answer "what was the heap doing" must not be
      // indistinguishable from one that cannot.
      expect(zip.readAsText('memory.txt')).toContain('(memory snapshot unavailable)')
      expect(zip.readAsText('memory.txt')).toContain('renderer-heap')
    } finally {
      failing.dispose()
    }
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

const MIB = 1024 * 1024

/** Captures what would reach `<userData>/logs/<session>/processMetrics.log`. */
const logSink: { channel: string; message: string }[] = []

class RecordingLogger extends AbstractLogger {
  constructor(private readonly _channel: string) {
    super()
  }
  protected override _log(_level: LogLevel, message: string): void {
    logSink.push({ channel: this._channel, message })
  }
}

const recordingLoggerService: ILoggerService = {
  _serviceBrand: undefined,
  createLogger: (channel) => new RecordingLogger(channel.id),
  setLevel: () => {},
  getLevel: () => LogLevel.Info,
}

describe('DiagnosticsMainService — renderer heap samples', () => {
  const sample = (used: number, level = 'normal') => ({
    used,
    limit: 4 * 1024 * MIB,
    level,
    holders: [],
  })

  let heapService: InstanceType<typeof DiagnosticsMainService>
  let heapRoot: string

  beforeEach(() => {
    logSink.length = 0
    heapRoot = mkdtempSync(join(tmpdir(), 'diagnostics-heap-test-'))
    heapService = new DiagnosticsMainService(
      {
        crashDumpsDir: join(heapRoot, 'Crashes'),
        logRoot: join(heapRoot, 'logs'),
        diagnosticsDir: join(heapRoot, 'diagnostics'),
        mode: 'release',
      },
      recordingLoggerService,
    )
  })

  afterEach(() => {
    heapService.dispose()
    rmSync(heapRoot, { recursive: true, force: true })
  })

  const heapLines = (): string[] =>
    logSink.filter((l) => l.message.startsWith('renderer-heap')).map((l) => l.message)

  it('writes the curve into the same channel the main heap uses', async () => {
    // Same channel id on purpose: the renderer's curve has to land on the main-heap
    // timeline of processMetrics.log, not in a file nobody would think to open.
    await heapService.reportRendererHeapSample(sample(3200 * MIB, 'critical'))
    expect(logSink.map((l) => l.channel)).toEqual(['processMetrics'])
    expect(heapLines()).toEqual([
      'renderer-heap window=0 used=3200MB limit=4096MB usedPct=78.1 level=critical',
    ])
  })

  it('keeps the newest 32 readings and drops the rest', async () => {
    for (let i = 1; i <= 40; i++) await heapService.reportRendererHeapSample(sample(i * MIB))
    const zip = new AdmZip(await heapService.createDiagnosticsZip())
    const lines = zip
      .readAsText('memory.txt')
      .split('\n')
      .filter((l) => l.includes('used='))
    expect(lines).toHaveLength(32)
    // Newest first, so the tail of the ramp reads off the top of the file.
    expect(lines[0]).toContain('used=40MB')
    expect(lines[31]).toContain('used=9MB')
  })

  it('drops readings that cannot be true instead of clamping them', async () => {
    // A zeroed sample would read as "the heap was fine" on exactly the report where it
    // was not, and a holder name carrying a newline would forge log lines.
    for (const used of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      await heapService.reportRendererHeapSample(sample(used))
    }
    expect(heapLines()).toEqual([])

    await heapService.reportRendererHeapSample({
      used: 900 * MIB,
      limit: Number.NaN,
      level: 'critical\n[error] forged',
      holders: [
        { name: 'acp', bytes: 412 * MIB, count: 3 },
        { name: 'bad\nname', bytes: 1 * MIB },
        { name: 'bad bytes', bytes: Number.NaN },
        { name: 'huge name that is far too long to be a holder', bytes: 1 * MIB },
      ],
    })
    expect(heapLines()).toEqual([
      'renderer-heap window=0 used=900MB limit=0MB level=unknown holders=acp:412MB(3)',
    ])
  })

  it('caps the holder breakdown so a sample cannot grow the line without bound', async () => {
    const holders = Array.from({ length: 12 }, (_v, i) => ({ name: `h${i}`, bytes: MIB }))
    await heapService.reportRendererHeapSample({ ...sample(900 * MIB), holders })
    const [line] = heapLines()
    expect(line?.match(/h\d+:\d+MB/g)).toHaveLength(8)
  })

  it('bounds the scan itself, not just what it keeps', async () => {
    // The names are renderer-supplied, and 128MB of frame fits an arbitrary number of
    // them: the loop has to be bounded by entries *read*, not entries *accepted*.
    const junk = Array.from({ length: 5000 }, () => ({ name: 'bad name', bytes: MIB }))
    await heapService.reportRendererHeapSample({
      ...sample(900 * MIB),
      holders: [...junk, { name: 'acp', bytes: MIB }],
    })
    // The reading itself still lands; only the attribution is (deliberately) given up.
    expect(heapLines()).toEqual([
      'renderer-heap window=0 used=900MB limit=4096MB usedPct=22.0 level=normal',
    ])
  })

  it('keeps the reading when the payload lost its holder list', async () => {
    // A skewed sender must not cost the heap reading: iterating `undefined` throws, and
    // the throw is swallowed on the far side of IPC, leaving nothing at all.
    await heapService.reportRendererHeapSample({
      used: 900 * MIB,
      limit: 4 * 1024 * MIB,
      level: 'normal',
    } as unknown as WireRendererHeapSample)
    await heapService.reportRendererHeapSample({
      ...sample(901 * MIB),
      holders: 'acp' as unknown as [],
    })
    expect(heapLines()).toHaveLength(2)
  })

  it('accepts a holder name up to the cap and rejects anything longer', async () => {
    await heapService.reportRendererHeapSample({
      ...sample(900 * MIB),
      holders: [
        { name: 'a'.repeat(32), bytes: MIB },
        { name: 'b'.repeat(33), bytes: MIB },
      ],
    })
    expect(heapLines()[0]).toContain(`holders=${'a'.repeat(32)}:1MB`)
    expect(heapLines()[0]).not.toContain('b'.repeat(33))
  })

  it('counts rejected readings, so a broken sender cannot look like an absent one', async () => {
    // `no samples recorded` alone is ambiguous: it is the same file whether the build
    // never had a curve or every report was thrown away.
    await heapService.reportRendererHeapSample(sample(Number.NaN))
    await heapService.reportRendererHeapSample(sample(0))
    const empty = new AdmZip(await heapService.createDiagnosticsZip())
    expect(empty.readAsText('memory.txt')).toContain('renderer-heap no samples recorded dropped=2')

    await heapService.reportRendererHeapSample(sample(900 * MIB))
    const withOne = new AdmZip(await heapService.createDiagnosticsZip())
    expect(withOne.readAsText('memory.txt')).toContain(
      'renderer-heap samples=1 dropped=2 (newest first)',
    )
  })

  it('stamps the window the wrapper was built for, not one the caller supplied', async () => {
    const scoped = createWindowScopedDiagnostics(heapService, 7)
    await scoped.reportRendererHeapSample(sample(3 * 1024 * MIB))
    expect(heapLines()[0]).toContain('window=7')
  })

  it('orders a partly filled ring newest first', async () => {
    // The ring starts empty, and the wrapping cursor only means "oldest" once it is
    // full — reading it early would put the oldest sample at the top.
    for (const used of [10 * MIB, 20 * MIB, 30 * MIB]) {
      await heapService.reportRendererHeapSample(sample(used))
    }
    const zip = new AdmZip(await heapService.createDiagnosticsZip())
    const lines = zip
      .readAsText('memory.txt')
      .split('\n')
      .filter((l) => l.includes('used='))
    expect(lines.map((l) => /used=(\d+)MB/.exec(l)?.[1])).toEqual(['30', '20', '10'])
  })

  it('reports the absence of samples rather than an empty file', async () => {
    const zip = new AdmZip(await heapService.createDiagnosticsZip())
    expect(zip.readAsText('memory.txt')).toContain('renderer-heap no samples recorded')
  })
})

describe('formatRendererHeapSample', () => {
  const base = { window: 1, used: 3200 * MIB, limit: 4096 * MIB, level: 'critical' }

  it('prints the watermark, the level and the holder breakdown', () => {
    expect(
      formatRendererHeapSample({
        ...base,
        holders: [
          { name: 'acp', bytes: 412 * MIB, count: 2 },
          { name: 'monaco', bytes: 38 * MIB },
        ],
      }),
    ).toBe(
      'renderer-heap window=1 used=3200MB limit=4096MB usedPct=78.1 level=critical ' +
        'holders=acp:412MB(2),monaco:38MB',
    )
  })

  it('omits the holder segment when nothing could be attributed', () => {
    // The absence is the finding: it says the culprit is outside the known holders,
    // which is a different lead from a line that never had the field.
    expect(formatRendererHeapSample({ ...base, holders: [] })).not.toContain('holders=')
  })

  it('omits the percentage when the heap limit never reported one', () => {
    expect(formatRendererHeapSample({ ...base, limit: 0, holders: [] })).toContain(
      'limit=0MB level=',
    )
  })
})
