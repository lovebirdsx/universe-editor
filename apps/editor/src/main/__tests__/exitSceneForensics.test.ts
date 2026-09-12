/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/exitSceneForensics.ts — reading the metrics
 *  curve back out of a dead session's log tail.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import {
  describeExitScene,
  parseExitScene,
  parseSessionStartMs,
  readExitScene,
  type ExitScene,
} from '../exitSceneForensics.js'

const SESSION_ID = '20260912T111811'
const SESSION_START_MS = new Date(2026, 8, 12, 11, 18, 11).getTime()
const LAST_ALIVE_MS = new Date(2026, 8, 12, 12, 15, 21).getTime()

function describeSceneForTest(scene: ExitScene): string {
  return describeExitScene(scene, { lastAliveAt: LAST_ALIVE_MS })
}

/** The shape a real session left behind before it was killed at ~12:15. */
const SAMPLE_LOG = [
  '[12:02:42] [warn] pid=29676 type=Tab mem=2300MB — renderer working set above 2048MB, OOM risk',
  '[12:02:52] [info] pid=26688 type=Browser mem=374MB cpu=1% | pid=25436 type=GPU mem=182MB cpu=0% | pid=29676 type=Tab mem=2624MB cpu=0% | pid=16072 type=Tab mem=1068MB cpu=0%',
  '[12:02:52] [info] main-heap heapUsed=91MB heapTotal=96MB external=16MB rss=303MB',
  '[12:02:56] [warn] hosted-processes cnt=71 window (window-4)#29676=2623MB/0% | window (window-2)#16072=1068MB/2% | tsserver#38368=131MB/0% — above 2048MB: window (window-4)#29676',
  '[12:10:42] [warn] pid=29676 type=Tab mem=2724MB — renderer working set above 2048MB, OOM risk',
  '[12:15:22] [info] pid=26688 type=Browser mem=302MB cpu=0% | pid=29676 type=Tab mem=687MB cpu=0%',
  '[12:15:22] [info] main-heap heapUsed=91MB heapTotal=96MB external=16MB rss=303MB',
].join('\n')

function parseSample(): ReturnType<typeof parseExitScene> {
  return parseExitScene(SAMPLE_LOG, { sessionStartMs: SESSION_START_MS })
}

describe('parseSessionStartMs', () => {
  it('reads the session id back as a local timestamp', () => {
    expect(parseSessionStartMs(SESSION_ID)).toBe(SESSION_START_MS)
  })

  it('rejects malformed ids', () => {
    expect(parseSessionStartMs('2026-09-12')).toBeUndefined()
    expect(parseSessionStartMs('')).toBeUndefined()
  })
})

describe('parseExitScene', () => {
  it('counts samples and tracks the main-process peaks', () => {
    const scene = parseSample()
    expect(scene.sampleCount).toBe(2)
    expect(scene.firstSampleAt).toBe(new Date(2026, 8, 12, 12, 2, 52).getTime())
    expect(scene.lastSampleAt).toBe(new Date(2026, 8, 12, 12, 15, 22).getTime())
    expect(scene.mainRssPeakMB).toBe(303)
    expect(scene.mainHeapUsedPeakMB).toBe(91)
    expect(scene.timeResolved).toBe(true)
  })

  it('merges the metrics line and the process tree into one renderer entry', () => {
    const scene = parseSample()
    const heavy = scene.renderers[0]
    expect(heavy?.pid).toBe(29676)
    expect(heavy?.window).toBe(4)
    expect(heavy?.type).toBe('Tab')
    expect(heavy?.peakMB).toBe(2724)
    expect(heavy?.lastMB).toBe(687)
    expect(heavy?.thresholdMB).toBe(2048)
  })

  it('spans the flagged window instead of reporting a single point', () => {
    const heavy = parseSample().renderers[0]
    expect(heavy?.flaggedSamples).toBe(3)
    expect(heavy?.flaggedFromAt).toBe(new Date(2026, 8, 12, 12, 2, 42).getTime())
    expect(heavy?.flaggedToAt).toBe(new Date(2026, 8, 12, 12, 10, 42).getTime())
  })

  it('does not double-count a renderer as a hosted process', () => {
    const scene = parseSample()
    expect(scene.renderers.map((process) => process.pid).sort()).toEqual([16072, 29676])
    expect(scene.hosted.map((process) => process.pid)).toEqual([38368])
  })

  it('describes the scene with the delta against the sentinel heartbeat', () => {
    const scene = { ...parseSample(), source: 'live' as const, truncated: false }
    const line = describeSceneForTest(scene)
    expect(line).toContain('last sample 12:15:22')
    expect(line).toContain('+1s vs sentinel heartbeat 12:15:21')
    expect(line).toContain('renderer over 2048MB')
    expect(line).toContain('(window-4)')
    expect(line).toContain('peak 2724MB')
    expect(line).toContain('samples 12:02:42→12:10:42')
    expect(line).toContain('other over-threshold: none')
    expect(line).not.toContain('tail only')
  })

  it('says so when every renderer stayed under its line', () => {
    const text =
      '[12:00:00] [info] pid=1 type=Browser mem=100MB cpu=0% | pid=9 type=Tab mem=800MB cpu=0%'
    const scene = {
      ...parseExitScene(text, { sessionStartMs: SESSION_START_MS }),
      source: 'live' as const,
      truncated: false,
    }
    const line = describeSceneForTest(scene)
    expect(line).toContain('heaviest renderer')
    expect(line).toContain('no renderer crossed its warning line')
  })

  it('survives empty and malformed input', () => {
    for (const text of [
      '',
      '<xml junk>',
      '[12:00:00] [warn] dropped 12 buffered log entries',
      '\n\n',
    ]) {
      const scene = parseExitScene(text, { sessionStartMs: SESSION_START_MS })
      expect(scene.sampleCount).toBe(0)
      expect(scene.renderers).toEqual([])
      expect(scene.hosted).toEqual([])
    }
  })

  it('parses ISO timestamps without a session anchor', () => {
    const text = '[2026-09-12T04:15:22.000Z] [info] pid=1 type=Browser mem=100MB cpu=0%'
    const scene = parseExitScene(text)
    expect(scene.timeResolved).toBe(true)
    expect(scene.lastSampleAt).toBe(Date.parse('2026-09-12T04:15:22.000Z'))
  })

  it('flags unparseable timestamps instead of dropping the memory facts', () => {
    const text = '[sep-12 12:15:22] [info] pid=1 type=Tab mem=100MB cpu=0%'
    const scene = parseExitScene(text, { sessionStartMs: SESSION_START_MS })
    expect(scene.timeResolved).toBe(false)
    expect(scene.sampleCount).toBe(1)
    expect(scene.renderers.map((process) => process.pid)).toEqual([1])
    expect(scene.renderers[0]?.peakMB).toBe(100)
  })

  it('reduces a command-line process name to its executable stem', () => {
    const commandLine = '"C:\\tools\\claude.exe" --mcp-config \'{"env":{"API_KEY":"ak-1"}}\''
    const text = `[12:00:00] [info] hosted-processes cnt=1 ${commandLine}#43140=900MB/0%`
    const scene = parseExitScene(text, { sessionStartMs: SESSION_START_MS })
    expect(scene.hosted[0]?.name).toBe('claude.exe')
    expect(JSON.stringify(scene)).not.toContain('ak-1')
  })

  it('rolls the date over midnight', () => {
    const text = [
      '[23:59:30] [info] pid=1 type=Browser mem=100MB cpu=0%',
      '[00:00:30] [info] pid=1 type=Browser mem=120MB cpu=0%',
    ].join('\n')
    const scene = parseExitScene(text, {
      sessionStartMs: new Date(2026, 8, 12, 23, 50, 0).getTime(),
    })
    expect((scene.lastSampleAt ?? 0) - (scene.firstSampleAt ?? 0)).toBe(60_000)
  })

  it('parses a multi-word Electron process type instead of dropping the sample', () => {
    const text = '[12:00:00] [info] pid=7 type=Sandbox helper mem=120MB cpu=0%'
    const scene = parseExitScene(text, { sessionStartMs: SESSION_START_MS })
    expect(scene.sampleCount).toBe(1)
    expect(scene.lastSampleAt).toBe(new Date(2026, 8, 12, 12, 0, 0).getTime())
  })

  it('treats the same pid under a different window as a recycled pid', () => {
    const text = [
      '[12:00:00] [warn] pid=999 type=Tab mem=2800MB — renderer working set above 2048MB, OOM risk',
      '[12:00:10] [info] hosted-processes cnt=1 window (window-4)#999=2800MB/0%',
      '[12:05:00] [info] hosted-processes cnt=2 window (window-2)#999=120MB/0% | tsserver#7=100MB/0%',
      '[12:05:10] [info] pid=999 type=Tab mem=120MB cpu=0%',
    ].join('\n')
    const scene = parseExitScene(text, { sessionStartMs: SESSION_START_MS })
    expect(scene.renderers.map((process) => process.window).sort()).toEqual([2, 4])
    expect(scene.renderers.find((process) => process.window === 4)?.peakMB).toBe(2800)
    expect(scene.renderers.find((process) => process.window === 2)?.peakMB).toBe(120)
  })

  it('keeps the first threshold it saw for a process', () => {
    const text = [
      '[12:00:00] [warn] pid=5 type=Tab mem=2300MB — renderer working set above 2048MB, OOM risk',
      '[12:00:10] [warn] hosted-processes cnt=1 window (window-1)#5=2300MB/0% — above 1024MB: window (window-1)#5',
    ].join('\n')
    const scene = parseExitScene(text, { sessionStartMs: SESSION_START_MS })
    expect(scene.renderers[0]?.thresholdMB).toBe(2048)
    expect(scene.renderers[0]?.flaggedSamples).toBe(2)
  })

  it('reports a metrics gap as a gap, not as a negative delta', () => {
    const text = '[12:10:00] [info] pid=1 type=Tab mem=800MB cpu=0%'
    const scene = {
      ...parseExitScene(text, { sessionStartMs: SESSION_START_MS }),
      source: 'live' as const,
      truncated: false,
    }
    const line = describeSceneForTest(scene)
    expect(line).toContain('last sample 12:10:00, 5min before the last heartbeat 12:15:21')
    expect(line).not.toContain('-5min')
  })

  it('reduces a command line to an executable stem whatever its shape', () => {
    const commandLines = [
      'claude.exe -p token=ak-1',
      'cmd.exe /c set TOKEN=ak-1',
      'git.exe -c http.extraHeader=AUTH:ak-1',
      '--api-key=ak-1',
      'C:\\tools\\bin\\node.exe --config C:\\cfg\\mcp.json',
    ]
    const text = `[12:00:00] [info] hosted-processes cnt=${commandLines.length} ${commandLines
      .map((command, index) => `${command}#${100 + index}=900MB/0%`)
      .join(' | ')}`
    const scene = parseExitScene(text, { sessionStartMs: SESSION_START_MS })
    expect(JSON.stringify(scene)).not.toContain('ak-1')
    expect(scene.hosted.map((process) => process.name)).toEqual([
      'claude.exe',
      'cmd.exe',
      'git.exe',
      undefined,
      'node.exe',
    ])
  })
})

describe('readExitScene', () => {
  it('treats an unknown session id as unreadable', async () => {
    const root = mkTempDir('ue-exit-scene-')
    try {
      expect(await readExitScene(root, '../../etc')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns undefined when the session has no metrics log', async () => {
    const root = mkTempDir('ue-exit-scene-')
    try {
      await mkdir(join(root, SESSION_ID), { recursive: true })
      expect(await readExitScene(root, SESSION_ID)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads the live file and reports the tail was cut', async () => {
    const root = mkTempDir('ue-exit-scene-')
    try {
      await mkdir(join(root, SESSION_ID), { recursive: true })
      await writeFile(join(root, SESSION_ID, 'processMetrics.log'), SAMPLE_LOG, 'utf8')
      const whole = await readExitScene(root, SESSION_ID)
      expect(whole?.source).toBe('live')
      expect(whole?.truncated).toBe(false)
      expect(whole?.renderers[0]?.peakMB).toBe(2724)

      const cut = await readExitScene(root, SESSION_ID, { tailBytes: 200 })
      expect(cut?.source).toBe('live')
      expect(cut?.truncated).toBe(true)
      expect(cut?.sampleCount).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to the newest rotated chunk when the live file has no samples', async () => {
    const root = mkTempDir('ue-exit-scene-')
    try {
      const dir = join(root, SESSION_ID)
      await mkdir(join(dir, 'rotated'), { recursive: true })
      await writeFile(join(dir, 'processMetrics.log'), '', 'utf8')
      await writeFile(
        join(dir, 'rotated', 'processMetrics.2026-09-12T04-02-47-000Z.log'),
        SAMPLE_LOG,
        'utf8',
      )
      const scene = await readExitScene(root, SESSION_ID)
      expect(scene?.source).toBe('rotated')
      expect(scene?.renderers[0]?.pid).toBe(29676)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks the scene truncated when the line cap drops earlier samples', async () => {
    const root = mkTempDir('ue-exit-scene-')
    try {
      await mkdir(join(root, SESSION_ID), { recursive: true })
      const peak =
        '[12:00:00] [warn] pid=999 type=Tab mem=9000MB — renderer working set above 2048MB, OOM risk'
      const filler = Array.from(
        { length: 10 },
        (_, index) => `[12:01:0${index % 10}] [info] pid=1 type=Browser mem=100MB cpu=0%`,
      )
      await writeFile(
        join(root, SESSION_ID, 'processMetrics.log'),
        [peak, ...filler].join('\n'),
        'utf8',
      )

      const whole = await readExitScene(root, SESSION_ID, { maxLines: 100 })
      expect(whole?.truncated).toBe(false)
      expect(whole?.renderers[0]?.peakMB).toBe(9000)

      const capped = await readExitScene(root, SESSION_ID, { maxLines: 5 })
      expect(capped?.truncated).toBe(true)
      expect(capped?.renderers.some((process) => process.pid === 999)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
