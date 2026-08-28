/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/bugRecording/bugRecordingMainService.ts
 *--------------------------------------------------------------------------------------------*/

import AdmZip from 'adm-zip'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BugRecordingMainService,
  type BugRecordingCaptureTarget,
  type BugRecordingMainServiceOptions,
} from '../bugRecordingMainService.js'
import type { LogMainService } from '../../log/logMainService.js'

const SESSION_ID = '20260828T101500'

function fakeCaptureTarget(marker = 'jpeg'): BugRecordingCaptureTarget {
  return {
    webContents: {
      capturePage: () =>
        Promise.resolve({
          getSize: () => ({ width: 2400, height: 1200 }),
          resize: () => ({ toJPEG: () => Buffer.from(`${marker}-resized`) }),
          toJPEG: () => Buffer.from(marker),
        }),
    },
  }
}

/** Capture target whose capturePage resolves only when the test releases it. */
function deferredCaptureTarget(): {
  readonly target: BugRecordingCaptureTarget
  readonly release: () => void
  readonly calls: () => number
} {
  const gates: (() => void)[] = []
  let calls = 0
  return {
    target: {
      webContents: {
        capturePage: () => {
          calls++
          return new Promise((resolve) => {
            gates.push(() =>
              resolve({
                getSize: () => ({ width: 800, height: 600 }),
                resize: () => ({ toJPEG: () => Buffer.from('resized') }),
                toJPEG: () => Buffer.from('jpeg'),
              }),
            )
          })
        },
      },
    },
    release: () => {
      for (const gate of gates.splice(0)) gate()
    },
    calls: () => calls,
  }
}

describe('BugRecordingMainService', () => {
  let root: string
  let logRoot: string
  let sessionDir: string
  let recordingsDir: string
  let logMain: LogMainService

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ue-bugrec-'))
    logRoot = join(root, 'logs')
    sessionDir = join(logRoot, SESSION_ID)
    recordingsDir = join(root, 'bug-recordings')
    await mkdir(sessionDir, { recursive: true })
    logMain = {
      getLogRoot: () => logRoot,
      getSessionId: () => SESSION_ID,
      getSessionDir: () => sessionDir,
    } as unknown as LogMainService
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function create(
    overrides: Partial<BugRecordingMainServiceOptions> = {},
    options: { readonly noWindow?: boolean; readonly target?: BugRecordingCaptureTarget } = {},
  ): BugRecordingMainService {
    const service = new BugRecordingMainService(
      { recordingsDir, piiPaths: [], revealInShell: false, ...overrides },
      logMain,
    )
    const target = options.noWindow === true ? undefined : (options.target ?? fakeCaptureTarget())
    service.setWindowProvider(() => target)
    return service
  }

  async function readZip(zipPath: string): Promise<Map<string, string>> {
    const entries = new Map<string, string>()
    for (const entry of new AdmZip(await readFile(zipPath)).getEntries()) {
      entries.set(entry.entryName, entry.getData().toString('utf8'))
    }
    return entries
  }

  it('starts idle and reports recording status after start', async () => {
    const service = create()
    expect(await service.getRecordingStatus()).toEqual({ state: 'idle' })

    const status = await service.startRecording({ workspaceFolders: ['/ws'] })
    expect(status.state).toBe('recording')
    expect(status.startedAt).toBeGreaterThan(0)
  })

  it('packs events, timeline, redaction notice and screenshots into the zip', async () => {
    const service = create()
    await service.startRecording({ workspaceFolders: ['/ws'] })
    await service.recordEvents([
      { kind: 'telemetry', ts: Date.now(), name: 'commandExecuted', data: { commandId: 'a.b' } },
      { kind: 'edit', ts: Date.now(), count: 3, resource: 'file:///ws/a.ts' },
    ])

    const result = await service.stopRecording({ redact: false })
    const entries = await readZip(result.zipPath)

    expect(entries.has('events.jsonl')).toBe(true)
    expect(entries.has('timeline.md')).toBe(true)
    expect(entries.has('redaction.md')).toBe(true)
    expect(result.eventCount).toBeGreaterThanOrEqual(2)
    expect(result.zipSizeBytes).toBeGreaterThan(0)
    expect([...entries.keys()].some((name) => name.startsWith('screenshots/'))).toBe(true)
    expect(entries.get('timeline.md')).toContain('命令执行')
    expect(entries.get('redaction.md')).toContain('未脱敏')
  })

  it('waits for in-flight writes so the last event before stop is in the bundle', async () => {
    const service = create()
    await service.startRecording({})
    await service.recordEvents([
      { kind: 'commandError', ts: Date.now(), commandId: 'last.command', message: 'boom' },
    ])

    const result = await service.stopRecording({ redact: false })
    const entries = await readZip(result.zipPath)
    expect(entries.get('events.jsonl')).toContain('last.command')
  })

  it('captures a screenshot on command failure but throttles bursts', async () => {
    const service = create({ minScreenshotIntervalMs: 60_000 })
    await service.startRecording({})
    const now = Date.now()
    await service.recordEvents([
      { kind: 'commandError', ts: now, commandId: 'x', message: 'boom' },
      { kind: 'commandError', ts: now + 5, commandId: 'y', message: 'boom' },
    ])

    const result = await service.stopRecording({ redact: false })
    // Only the start screenshot lands: the throttle window swallows the rest.
    expect(result.screenshotCount).toBe(1)
    const entries = await readZip(result.zipPath)
    expect(entries.get('events.jsonl')).toContain('"commandId":"y"')
  })

  it('packs screenshots still queued when the user hits stop', async () => {
    const { target, release, calls } = deferredCaptureTarget()
    const service = create({ minScreenshotIntervalMs: 0 }, { target })
    await service.startRecording({})
    await service.recordEvents([{ kind: 'marker', ts: Date.now() }])
    // The start shot occupies the chain, so the marker's shot is still queued —
    // exactly the case where reading `_active` inside the capture would drop it.
    expect(calls()).toBe(1)

    const stopping = service.stopRecording({ redact: false })
    release()
    await vi.waitFor(() => expect(calls()).toBe(2))
    release()

    const result = await stopping
    expect(result.screenshotCount).toBe(2)
  })

  it('gives up on a wedged capture instead of hanging the stop path', async () => {
    const { target } = deferredCaptureTarget()
    const service = create({ settleCapturesTimeoutMs: 30 }, { target })
    await service.startRecording({})

    // capturePage never resolves; stop must still produce a bundle.
    const result = await service.stopRecording({ redact: false })
    expect(result.screenshotCount).toBe(0)
    expect(await service.getRecordingStatus()).toEqual({ state: 'idle' })
  })

  it('resumes the recording when packing fails so the user can retry the stop', async () => {
    // A plain file where the output dir belongs: mkdir fails, so packing does too.
    await writeFile(recordingsDir, 'not a directory', 'utf8')
    const service = create()
    const started = await service.startRecording({})
    await service.recordEvents([{ kind: 'marker', ts: Date.now() }])

    await expect(service.stopRecording({ redact: false })).rejects.toThrow()
    expect(await service.getRecordingStatus()).toEqual({
      state: 'recording',
      startedAt: started.startedAt,
    })

    // Still recording: further events land, and the retry packs them.
    await service.recordEvents([
      { kind: 'commandError', ts: Date.now(), commandId: 'after.retry', message: 'boom' },
    ])
    await rm(recordingsDir, { force: true })
    const result = await service.stopRecording({ redact: false })
    const entries = await readZip(result.zipPath)
    expect(entries.get('events.jsonl')).toContain('after.retry')
    expect(await service.getRecordingStatus()).toEqual({ state: 'idle' })
  })

  it('evicts the oldest screenshots past the ring-buffer cap', async () => {
    const service = create({ maxScreenshots: 2, minScreenshotIntervalMs: 0 })
    await service.startRecording({})
    for (let i = 0; i < 4; i++) {
      await service.recordEvents([{ kind: 'marker', ts: Date.now() + i }])
    }

    const result = await service.stopRecording({ redact: false })
    expect(result.screenshotCount).toBe(2)
    const entries = await readZip(result.zipPath)
    const shots = [...entries.keys()].filter((name) => name.startsWith('screenshots/')).sort()
    expect(shots).toHaveLength(2)
    // Newest kept, oldest gone.
    expect(shots.at(-1)).toBe('screenshots/0005.jpg')
    expect(shots).not.toContain('screenshots/0001.jpg')
  })

  it('drops timeline references to screenshots evicted from the bundle', async () => {
    const service = create({ maxScreenshots: 1, minScreenshotIntervalMs: 0 })
    await service.startRecording({})
    await service.recordEvents([{ kind: 'marker', ts: Date.now() }])
    await service.recordEvents([{ kind: 'marker', ts: Date.now() + 1 }])

    const result = await service.stopRecording({ redact: false })
    const entries = await readZip(result.zipPath)
    const events = entries.get('events.jsonl') ?? ''
    expect(events).not.toContain('screenshots/0001.jpg')
    expect(entries.get('timeline.md')).not.toContain('screenshots/0001.jpg')
  })

  it('masks pii paths when redaction is requested and keeps jsonl parseable', async () => {
    const secretDir = join(root, 'secret-workspace')
    const service = create({ piiPaths: [secretDir] })
    await service.startRecording({ workspaceFolders: [secretDir] })
    await service.recordEvents([
      { kind: 'edit', ts: Date.now(), count: 1, resource: `${secretDir}/a.ts` },
    ])

    const result = await service.stopRecording({ redact: true })
    const entries = await readZip(result.zipPath)
    const events = entries.get('events.jsonl') ?? ''

    expect(events).not.toContain(secretDir)
    expect(events).toContain('<pii>')
    for (const line of events.split('\n').filter((l) => l.trim() !== '')) {
      expect(() => JSON.parse(line) as unknown).not.toThrow()
    }
    expect(entries.get('redaction.md')).toContain('无法脱敏')
  })

  it('includes session log tails and errors.jsonl', async () => {
    await writeFile(join(sessionDir, 'editor.log'), 'INFO ok\nERROR exploded\n', 'utf8')
    await writeFile(join(sessionDir, 'errors.jsonl'), '{"fingerprint":"abc"}\n', 'utf8')

    const service = create()
    await service.startRecording({})
    const result = await service.stopRecording({ redact: false })
    const entries = await readZip(result.zipPath)

    expect(entries.get(`logs/${SESSION_ID}/editor.log`)).toContain('ERROR exploded')
    expect(entries.get(`errors-${SESSION_ID}.jsonl`)).toContain('abc')
    expect(entries.get('timeline.md')).toContain('ERROR exploded')
  })

  it('packs referenced acp transcripts', async () => {
    const transcript = join(root, 'chat.jsonl')
    await writeFile(transcript, '{"role":"user"}\n', 'utf8')

    const service = create()
    await service.startRecording({})
    const result = await service.stopRecording({
      redact: false,
      transcripts: [{ title: 'fix the loader', path: transcript }],
    })
    const entries = await readZip(result.zipPath)

    const name = [...entries.keys()].find((n) => n.startsWith('transcript-1-'))
    expect(name).toBeDefined()
    expect(entries.get(name as string)).toContain('"role":"user"')
    expect(entries.get('timeline.md')).toContain('transcript-1-')
  })

  it('inlines collected environment info', async () => {
    const service = create({ collectEnvironment: () => Promise.resolve('# Env\nApp: 1.2.3') })
    await service.startRecording({})
    const result = await service.stopRecording({ redact: false })
    const entries = await readZip(result.zipPath)

    expect(entries.get('environment.md')).toContain('App: 1.2.3')
    expect(entries.get('timeline.md')).toContain('App: 1.2.3')
  })

  it('is a no-op when recording without a window and rejects stop without a recording', async () => {
    const service = create({}, { noWindow: true })
    await service.startRecording({})
    await service.recordEvents([{ kind: 'marker', ts: Date.now() }])

    const result = await service.stopRecording({ redact: false })
    expect(result.screenshotCount).toBe(0)
    await expect(service.stopRecording({ redact: false })).rejects.toThrow('no recording')
  })

  it('ignores a second start and events recorded while idle', async () => {
    const service = create()
    const first = await service.startRecording({})
    const second = await service.startRecording({})
    expect(second.startedAt).toBe(first.startedAt)

    await service.stopRecording({ redact: false })
    await service.recordEvents([{ kind: 'marker', ts: Date.now() }])
    expect(await service.getRecordingStatus()).toEqual({ state: 'idle' })
  })

  it('detects an interrupted recording on the next launch and exports it', async () => {
    const crashed = create()
    await crashed.startRecording({ workspaceFolders: ['/ws'] })
    await crashed.recordEvents([
      { kind: 'commandError', ts: Date.now(), commandId: 'crash.me', message: 'boom' },
    ])
    // Simulate a crash: no stopRecording, so the raw dir survives.
    await crashed.dispose()

    const relaunched = create()
    const orphan = await relaunched.consumeOrphanRecording()
    expect(orphan).not.toBeNull()
    expect(orphan?.eventCount).toBeGreaterThan(0)

    const result = await relaunched.exportOrphanRecording({ redact: false })
    const entries = await readZip(result.zipPath)
    expect(entries.get('events.jsonl')).toContain('crash.me')
    expect(entries.get('redaction.md')).toContain('异常中断')
    expect(entries.get('timeline.md')).toContain('异常中断')

    // Consumed: a second export has nothing left to do.
    await expect(relaunched.exportOrphanRecording({ redact: false })).rejects.toThrow(
      'no interrupted recording',
    )
  })

  it('dates an interrupted recording by its last write, not by the export time', async () => {
    const crashed = create()
    const started = await crashed.startRecording({})
    await crashed.recordEvents([{ kind: 'marker', ts: Date.now() }])
    await crashed.dispose()

    const relaunched = create()
    await relaunched.consumeOrphanRecording()
    const result = await relaunched.exportOrphanRecording({ redact: false })
    const entries = await readZip(result.zipPath)

    // A crash gives no end timestamp, so the duration comes from events.jsonl's
    // mtime — seconds, not the hours-or-days-later moment the user exports.
    const stamp = new Date(started.startedAt ?? 0).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    expect(result.zipPath).toContain(stamp)
    expect(entries.get('timeline.md')).toContain('录制 0 秒')
  })

  it('reports no orphan when every recording was stopped cleanly', async () => {
    const service = create()
    await service.startRecording({})
    await service.stopRecording({ redact: false })

    const relaunched = create()
    expect(await relaunched.consumeOrphanRecording()).toBeNull()
  })

  it('reveals the bundle only when revealInShell is not disabled', async () => {
    const revealed: string[] = []
    const service = create({ revealInShell: true, revealItem: (p) => revealed.push(p) })
    await service.startRecording({})
    const result = await service.stopRecording({ redact: false })
    expect(revealed).toEqual([result.zipPath])
  })
})
