/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Death-scene replay for abnormal exits. When the process is killed from outside
 *  there is no dump and no WER event — but the previous session's own
 *  `processMetrics.log` still holds the memory curve up to the moment the log
 *  stopped, which is the only witness we have for "what was climbing just before
 *  it died". Reading it back on the next launch turns a bare "terminated
 *  abnormally" into "renderer pid 29676 (window-4) sat at 2747MB for 8 minutes
 *  and the last sample lands 1s after the sentinel heartbeat".
 *
 *  Parse-only against the written text: it deliberately does not import the
 *  writer's thresholds — the warning lines name their own threshold, so a retuned
 *  warning level is followed automatically instead of silently breaking the
 *  reader. Must never import electron or the metrics writer; nothing here may
 *  throw into the startup path.
 *--------------------------------------------------------------------------------------------*/

import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { redactProcessName } from './services/processMonitor/processNameSafety.js'

export interface SceneProcess {
  readonly pid: number
  /** Process-tree name, e.g. `window (window-4)`; undefined for metrics-only pids. */
  readonly name: string | undefined
  /** Window id parsed out of the process-tree name — the pid → window mapping. */
  readonly window: number | undefined
  /** `type=` from the app-metrics line (`Tab` / `GPU` / `Utility` …). */
  readonly type: string | undefined
  readonly peakMB: number
  readonly lastMB: number
  readonly lastSeenAt: number | undefined
  /** Samples in which the writer flagged this pid as over its line. */
  readonly flaggedSamples: number
  readonly flaggedFromAt: number | undefined
  readonly flaggedToAt: number | undefined
  /** Over-threshold line the writer named in the flagged samples. */
  readonly thresholdMB: number | undefined
}

export interface ExitSceneTail {
  readonly sampleCount: number
  readonly firstSampleAt: number | undefined
  readonly lastSampleAt: number | undefined
  readonly mainRssPeakMB: number | undefined
  readonly mainHeapUsedPeakMB: number | undefined
  readonly renderers: readonly SceneProcess[]
  readonly hosted: readonly SceneProcess[]
  /** Whether at least one timestamp could be interpreted at all. */
  readonly timeResolved: boolean
}

export interface ExitScene extends ExitSceneTail {
  readonly source: 'live' | 'rotated'
  /** The text is a tail (byte window or line cap) — the session's start is not in it. */
  readonly truncated: boolean
}

export const PROCESS_METRICS_CHANNEL = 'processMetrics'

/** Enough for ~100 sampling cycles: far past the climb that precedes a kill. */
export const EXIT_SCENE_TAIL_BYTES = 512 * 1024

export const EXIT_SCENE_MAX_LINES = 4000

/** Session directory names are `YYYYMMDDTHHmmss` — also the path-traversal guard. */
export const SESSION_DIR_NAME_RE = /^\d{8}T\d{6}$/
const SESSION_ID_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/
const LINE_RE = /^\[([^\]]+)\] \[[a-z]+\] (.*)$/
// Electron's process type is not always one word (`Sandbox helper`, `Pepper
// Plugin Broker`), and `\S+` would swallow the ` mem=` that has to follow it.
const APP_METRICS_RE = /pid=(\d+) type=([^|]*?) mem=(\d+)MB cpu=(\d+)%/g
const RENDERER_WARNING_RE =
  /^pid=(\d+) type=([^|]*?) mem=(\d+)MB.*renderer working set above (\d+)MB/
const MAIN_HEAP_RE = /^main-heap heapUsed=(\d+)MB heapTotal=(\d+)MB external=(\d+)MB rss=(\d+)MB/
const HOSTED_TREE_RE = /^hosted-processes cnt=(\d+) (.*?)(?:\s+[—–-]\s+above (\d+)MB: (.*))?$/
const HOSTED_ITEM_RE = /^(.+)#(\d+)=(\d+)MB\/([^%]+)%$/
const HOSTED_OVER_RE = /^(.+)#(\d+)$/
const WINDOW_NAME_RE = /window-(\d+)/
const CLOCK_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
const ROTATED_NAME_RE = /^processMetrics\..*\.log$/

const DAY_MS = 24 * 60 * 60 * 1000
// A clock time that lands more than this before the previous sample belongs to
// the next day, not to a rewind: sessions cross midnight, logs never go back.
const MIDNIGHT_ROLLOVER_MS = 12 * 60 * 60 * 1000

/** `20260912T111811` → local epoch ms of that session's start; undefined if malformed. */
export function parseSessionStartMs(sessionId: string): number | undefined {
  const m = SESSION_ID_RE.exec(sessionId)
  if (!m) return undefined
  const values = m.slice(1, 7).map((part) => Number(part))
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) return undefined
  const year = values[0] ?? 0
  const month = values[1] ?? 1
  const day = values[2] ?? 1
  const hours = values[3] ?? 0
  const minutes = values[4] ?? 0
  const seconds = values[5] ?? 0
  return new Date(year, month - 1, day, hours, minutes, seconds).getTime()
}

interface SceneAccumulator {
  /** Map key: one process incarnation (`<pid>#<n>`) — see `entry`. */
  key: string
  pid: number
  name: string | undefined
  window: number | undefined
  type: string | undefined
  peakMB: number
  lastMB: number
  lastSeenAt: number | undefined
  flaggedSamples: number
  flaggedFromAt: number | undefined
  flaggedToAt: number | undefined
  thresholdMB: number | undefined
  inMetrics: boolean
  inHosted: boolean
}

/**
 * Parse a `processMetrics.log` tail into the death scene it describes. Every
 * field is best-effort: unparseable timestamps leave the time fields undefined
 * while the memory facts still come through.
 */
export function parseExitScene(
  logText: string,
  options: { readonly sessionStartMs?: number | undefined } = {},
): ExitSceneTail {
  const sessionStartMs = options.sessionStartMs
  const processes = new Map<string, SceneAccumulator>()
  let sampleCount = 0
  let firstSampleAt: number | undefined
  let lastSampleAt: number | undefined
  let mainRssPeakMB: number | undefined
  let mainHeapUsedPeakMB: number | undefined
  let timeResolved = false
  let dayOffsetMs = 0
  let previousAt = sessionStartMs

  const resolveTime = (raw: string): number | undefined => {
    if (raw.includes('T')) {
      const parsed = Date.parse(raw)
      if (!Number.isFinite(parsed)) return undefined
      previousAt = parsed
      timeResolved = true
      return parsed
    }
    const m = CLOCK_RE.exec(raw)
    if (!m || sessionStartMs === undefined) return undefined
    const start = new Date(sessionStartMs)
    let candidate =
      new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate(),
        Number(m[1] ?? 0),
        Number(m[2] ?? 0),
        Number(m[3] ?? 0),
        m[4] === undefined ? 0 : Number(m[4].padEnd(3, '0')),
      ).getTime() + dayOffsetMs
    if (previousAt !== undefined && candidate < previousAt - MIDNIGHT_ROLLOVER_MS) {
      dayOffsetMs += DAY_MS
      candidate += DAY_MS
    }
    previousAt = candidate
    timeResolved = true
    return candidate
  }

  const windowOf = (name: string | undefined): number | undefined => {
    if (name === undefined) return undefined
    const m = WINDOW_NAME_RE.exec(name)
    return m?.[1] === undefined ? undefined : Number(m[1])
  }

  // A pid is only unique while its process lives. Keying by pid alone merges a
  // closed window's renderer with whatever recycled its pid, which then reports
  // one process's peak and flagged span under the other's window id.
  let incarnation = 0
  const activeKeyByPid = new Map<number, string>()

  const createAccumulator = (pid: number): SceneAccumulator => {
    incarnation += 1
    const acc: SceneAccumulator = {
      key: `${pid}#${incarnation}`,
      pid,
      name: undefined,
      window: undefined,
      type: undefined,
      peakMB: 0,
      lastMB: 0,
      lastSeenAt: undefined,
      flaggedSamples: 0,
      flaggedFromAt: undefined,
      flaggedToAt: undefined,
      thresholdMB: undefined,
      inMetrics: false,
      inHosted: false,
    }
    processes.set(acc.key, acc)
    activeKeyByPid.set(pid, acc.key)
    return acc
  }

  const entry = (pid: number, windowHint?: number): SceneAccumulator => {
    const activeKey = activeKeyByPid.get(pid)
    const current = activeKey === undefined ? undefined : processes.get(activeKey)
    if (!current) return createAccumulator(pid)
    // `window (window-4)` never becomes `window (window-2)`: a different window
    // id on the same pid means the pid was recycled, so this is a new process.
    if (windowHint !== undefined && current.window !== undefined && current.window !== windowHint) {
      return createAccumulator(pid)
    }
    return current
  }

  const recordMemory = (
    acc: SceneAccumulator,
    memMB: number,
    at: number | undefined,
    type?: string,
    name?: string,
  ): void => {
    acc.peakMB = Math.max(acc.peakMB, memMB)
    acc.lastMB = memMB
    if (at !== undefined) acc.lastSeenAt = at
    if (type !== undefined) acc.type = type
    if (name !== undefined) {
      acc.name = name
      const window = windowOf(name)
      if (window !== undefined) acc.window = window
    }
  }

  const markFlagged = (
    pid: number,
    thresholdMB: number | undefined,
    at: number | undefined,
  ): void => {
    const acc = entry(pid)
    acc.flaggedSamples += 1
    // The renderer warning and the process tree carry independent thresholds;
    // keeping the first one names the line this process actually lives on.
    if (thresholdMB !== undefined) acc.thresholdMB ??= thresholdMB
    if (at !== undefined) {
      acc.flaggedFromAt ??= at
      acc.flaggedToAt = at
    }
  }

  for (const line of logText.split(/\r?\n/)) {
    const lineMatch = LINE_RE.exec(line)
    if (!lineMatch) continue
    const at = resolveTime(lineMatch[1] ?? '')
    const message = lineMatch[2] ?? ''

    const rendererWarning = RENDERER_WARNING_RE.exec(message)
    if (rendererWarning) {
      const acc = entry(Number(rendererWarning[1]))
      // The warning repeats the reading it is warning about — count it, or a
      // renderer that only ever appears on warning lines reads as having no curve.
      recordMemory(acc, Number(rendererWarning[3]), at, rendererWarning[2] ?? undefined)
      markFlagged(acc.pid, Number(rendererWarning[4]), at)
      continue
    }

    const mainHeap = MAIN_HEAP_RE.exec(message)
    if (mainHeap) {
      const heapUsed = Number(mainHeap[1])
      const rss = Number(mainHeap[4])
      mainHeapUsedPeakMB = Math.max(mainHeapUsedPeakMB ?? 0, heapUsed)
      mainRssPeakMB = Math.max(mainRssPeakMB ?? 0, rss)
      continue
    }

    const hosted = HOSTED_TREE_RE.exec(message)
    if (hosted) {
      for (const part of (hosted[2] ?? '').split(' | ')) {
        const item = HOSTED_ITEM_RE.exec(part.trim())
        if (!item) continue
        const name = redactProcessName(item[1] ?? '')
        const acc = entry(Number(item[2]), windowOf(name))
        acc.inHosted = true
        recordMemory(acc, Number(item[3]), at, undefined, name)
      }
      if (hosted[3] !== undefined) {
        const threshold = Number(hosted[3])
        for (const part of (hosted[4] ?? '').split(',')) {
          const over = HOSTED_OVER_RE.exec(part.trim())
          if (over) markFlagged(Number(over[2]), threshold, at)
        }
      }
      continue
    }

    let sawMetrics = false
    for (const metric of message.matchAll(APP_METRICS_RE)) {
      sawMetrics = true
      const acc = entry(Number(metric[1]))
      acc.inMetrics = true
      recordMemory(acc, Number(metric[3]), at, metric[2] ?? '')
    }
    if (sawMetrics) {
      sampleCount += 1
      if (at !== undefined) {
        firstSampleAt ??= at
        lastSampleAt = at
      }
    }
  }

  const collected = [...processes.values()]
  const toSceneProcess = (acc: SceneAccumulator): SceneProcess => ({
    pid: acc.pid,
    name: acc.name,
    window: acc.window,
    type: acc.type,
    peakMB: acc.peakMB,
    lastMB: acc.lastMB,
    lastSeenAt: acc.lastSeenAt,
    flaggedSamples: acc.flaggedSamples,
    flaggedFromAt: acc.flaggedFromAt,
    flaggedToAt: acc.flaggedToAt,
    thresholdMB: acc.thresholdMB,
  })
  const isRenderer = (acc: SceneAccumulator): boolean =>
    acc.type === 'Tab' || (acc.type === undefined && acc.window !== undefined)
  const renderers = collected
    .filter(isRenderer)
    .map(toSceneProcess)
    .sort((a, b) => b.peakMB - a.peakMB)
  // Spawned Node children (agent, extension host, tsserver) never appear in
  // app.getAppMetrics() — the process tree is the only place they show up, and
  // that asymmetry is what separates them from Electron's own GPU/utility pids.
  const hostedOnly = collected
    .filter((acc) => !isRenderer(acc) && !acc.inMetrics)
    .map(toSceneProcess)
    .sort((a, b) => b.peakMB - a.peakMB)

  return {
    sampleCount,
    firstSampleAt,
    lastSampleAt,
    mainRssPeakMB,
    mainHeapUsedPeakMB,
    renderers,
    hosted: hostedOnly,
    timeResolved,
  }
}

function formatClock(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Magnitude only — the direction is spelled out where the delta is reported. */
function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 1000) return `${abs}ms`
  if (abs < 60_000) return `${Math.round(abs / 1000)}s`
  return `${Math.round(abs / 60_000)}min`
}

function describeProcess(process: SceneProcess): string {
  const window = process.window === undefined ? '' : ` (window-${process.window})`
  return `pid ${process.pid}${window}`
}

/**
 * One line describing what the previous session's log tail says. `reference` is
 * the sentinel heartbeat, which bounds the death to the interval after it — the
 * last sample both refines that bound and shows what was climbing inside it.
 */
export function describeExitScene(
  scene: ExitScene,
  reference: { readonly lastAliveAt: number },
): string {
  const parts: string[] = []
  if (scene.lastSampleAt !== undefined) {
    const delta = scene.lastSampleAt - reference.lastAliveAt
    // Metrics stopping before the heartbeat means the writer stalled (or the tail
    // was cut) rather than the process dying late — say which, don't print a
    // signed number the reader has to interpret.
    parts.push(
      delta < 0
        ? `last sample ${formatClock(scene.lastSampleAt)}, ${formatDuration(delta)} before the last heartbeat ${formatClock(reference.lastAliveAt)}`
        : `last sample ${formatClock(scene.lastSampleAt)} (+${formatDuration(delta)} vs sentinel heartbeat ${formatClock(reference.lastAliveAt)})`,
    )
  } else {
    parts.push('no timestamped sample')
  }
  parts.push(`samples=${scene.sampleCount}`)
  if (scene.mainRssPeakMB !== undefined) {
    parts.push(
      `main rss peak ${scene.mainRssPeakMB}MB, heapUsed peak ${scene.mainHeapUsedPeakMB ?? 0}MB`,
    )
  }

  const flaggedRenderers = scene.renderers.filter((process) => process.flaggedSamples > 0)
  const heaviest = scene.renderers[0]
  if (flaggedRenderers.length > 0) {
    const threshold = flaggedRenderers[0]?.thresholdMB
    const detail = flaggedRenderers
      .slice(0, 3)
      .map((process) => {
        const span =
          process.flaggedFromAt !== undefined && process.flaggedToAt !== undefined
            ? `, ${process.flaggedSamples} samples ${formatClock(process.flaggedFromAt)}→${formatClock(process.flaggedToAt)}`
            : ''
        return `${describeProcess(process)} peak ${process.peakMB}MB (last ${process.lastMB}MB${span})`
      })
      .join('; ')
    parts.push(`renderer over ${threshold ?? '?'}MB: ${detail}`)
  } else if (heaviest) {
    parts.push(
      `heaviest renderer: ${describeProcess(heaviest)} peak ${heaviest.peakMB}MB — no renderer crossed its warning line`,
    )
  } else {
    parts.push('no renderer samples')
  }

  const flaggedHosted = scene.hosted.filter((process) => process.flaggedSamples > 0)
  parts.push(
    flaggedHosted.length > 0
      ? `other over-threshold: ${flaggedHosted
          .slice(0, 3)
          .map((process) => `${process.name ?? 'unknown'}#${process.pid} peak ${process.peakMB}MB`)
          .join('; ')}`
      : 'other over-threshold: none',
  )

  let line = `${scene.source === 'rotated' ? 'previous-session rotated log' : 'previous-session log tail'}: ${parts.join('; ')}`
  if (scene.truncated) line += ' (tail only)'
  if (!scene.timeResolved) {
    line += ' (timestamps unparseable — logging.timestampFormat changed?)'
  }
  return line
}

async function readTail(
  path: string,
  tailBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean } | undefined> {
  try {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const start = size > tailBytes ? size - tailBytes : 0
      const length = size - start
      if (length <= 0) return { text: '', truncated: false }
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      let text = buffer.toString('utf8')
      const truncated = start > 0
      if (truncated) {
        const firstNewline = text.indexOf('\n')
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
      }
      return { text, truncated }
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

async function newestRotatedChunk(sessionDir: string): Promise<string | undefined> {
  try {
    const entries = await readdir(join(sessionDir, 'rotated'))
    // The writer names chunks by ISO timestamp with fixed-width fields, so the
    // lexicographic maximum is the newest chunk.
    return entries
      .filter((name) => ROTATED_NAME_RE.test(name))
      .sort()
      .at(-1)
  } catch {
    return undefined
  }
}

/**
 * Read the previous session's metrics tail. Returns undefined when nothing can be
 * read at all — callers must surface that rather than treating it as "nothing to
 * report". Best-effort throughout: it runs on the startup path and may only ever
 * cost a log line.
 */
export async function readExitScene(
  logsRoot: string,
  sessionId: string,
  options: { readonly tailBytes?: number; readonly maxLines?: number } = {},
): Promise<ExitScene | undefined> {
  // Doubles as traversal protection: the id comes from a file on disk.
  if (!SESSION_DIR_NAME_RE.test(sessionId)) return undefined
  const tailBytes = options.tailBytes ?? EXIT_SCENE_TAIL_BYTES
  const maxLines = options.maxLines ?? EXIT_SCENE_MAX_LINES
  const sessionDir = join(logsRoot, sessionId)
  const sessionStartMs = parseSessionStartMs(sessionId)

  // Cutting the head of the window can drop the very peak the reader is looking
  // for, so both cuts have to be visible: a silent line cap would let a 9GB
  // renderer vanish and the scene read as calm.
  const takeTailLines = (text: string): { text: string; cut: boolean } => {
    const lines = text.split(/\r?\n/)
    if (lines.length <= maxLines) return { text, cut: false }
    return { text: lines.slice(-maxLines).join('\n'), cut: true }
  }

  const live = await readTail(join(sessionDir, `${PROCESS_METRICS_CHANNEL}.log`), tailBytes)
  if (live) {
    const tail = takeTailLines(live.text)
    const scene = parseExitScene(tail.text, { sessionStartMs })
    if (scene.sampleCount > 0) {
      return { ...scene, source: 'live', truncated: live.truncated || tail.cut }
    }
  }

  const rotatedName = await newestRotatedChunk(sessionDir)
  if (rotatedName === undefined) return undefined
  const rotated = await readTail(join(sessionDir, 'rotated', rotatedName), tailBytes)
  if (!rotated) return undefined
  const tail = takeTailLines(rotated.text)
  const scene = parseExitScene(tail.text, { sessionStartMs })
  if (scene.sampleCount === 0) return undefined
  return { ...scene, source: 'rotated', truncated: rotated.truncated || tail.cut }
}
