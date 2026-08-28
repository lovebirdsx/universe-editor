/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Packs a recording's raw directory into the zip evidence bundle: events.jsonl,
 *  the generated timeline.md, screenshots, session log tails, errors.jsonl, ACP
 *  transcripts and environment info — optionally routed through redaction first.
 *  Shared by the normal stop path and the crash-orphan export path.
 *  Electron-free (fs + adm-zip only) so it stays unit-testable.
 *--------------------------------------------------------------------------------------------*/

import AdmZip from 'adm-zip'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { redactErrorText } from '@universe-editor/platform'
import type {
  BugRecordingResult,
  BugRecordingTranscriptRef,
  PersistedBugRecordEvent,
} from '../../../shared/ipc/bugRecorderService.js'
import { collectSessionLogTails } from '../log/logTails.js'
import {
  buildBugRecordingTimeline,
  extractLogExcerpt,
  parseEventsJsonl,
} from './bugRecordingReport.js'

export const EVENTS_FILE = 'events.jsonl'
export const META_FILE = 'meta.json'
export const SCREENSHOTS_DIR = 'screenshots'

const LOG_TAIL_BYTES = 512 * 1024
const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024
const MAX_TRANSCRIPTS = 5
const LOG_EXCERPT_MAX_LINES = 200
/**
 * redactErrorText defaults to 8KB, which would truncate whole JSONL lines; the
 * cap here only needs to bound pathological single lines.
 */
const REDACT_MAX_LENGTH = 64_000

/** Persisted alongside the events so an orphan export can recover the context. */
export interface BugRecordingMeta {
  readonly startedAt: number
  readonly sessionId: string
  readonly workspaceFolders?: readonly string[]
}

export interface BugRecordingArchiveInput {
  /** Raw recording dir: <sessionDir>/bug-recording-<stamp>/ */
  readonly rawDir: string
  /** Log session dir the recording belongs to, for log tails and errors.jsonl. */
  readonly sessionDir: string
  readonly meta: BugRecordingMeta
  readonly outputDir: string
  readonly endedAt: number
  readonly redact: boolean
  readonly piiPaths: readonly string[]
  readonly transcripts?: readonly BugRecordingTranscriptRef[]
  readonly environment?: string
  readonly crashDumpsDir?: string
  /** True when the recording was cut short by a crash rather than stopped by the user. */
  readonly interrupted?: boolean
}

function redactLines(text: string, redact: boolean, piiPaths: readonly string[]): string {
  if (!redact) return text
  return text
    .split('\n')
    .map((line) =>
      line === '' ? line : redactErrorText(line, { piiPaths, maxLength: REDACT_MAX_LENGTH }),
    )
    .join('\n')
}

async function readFileIfExists(path: string): Promise<Buffer | null> {
  return fs.readFile(path).catch(() => null)
}

async function listScreenshots(rawDir: string): Promise<string[]> {
  const entries = await fs.readdir(join(rawDir, SCREENSHOTS_DIR)).catch(() => [] as string[])
  return entries.filter((name) => name.endsWith('.jpg')).sort()
}

async function listCrashDumps(dir: string): Promise<string[]> {
  const found: { path: string; mtime: number }[] = []
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth < 0) return
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => null)
    if (entries === null) return
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth - 1)
      } else if (entry.name.toLowerCase().endsWith('.dmp')) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) found.push({ path: full, mtime: stat.mtimeMs })
      }
    }
  }
  await walk(dir, 3)
  return found.sort((a, b) => b.mtime - a.mtime).map((d) => d.path)
}

function buildRedactionNotice(redact: boolean, interrupted: boolean): string {
  const lines = ['# 脱敏说明', '']
  if (redact) {
    lines.push(
      '本包已脱敏：用户名与账号目录、绝对路径、密钥 token 被替换为 `<user>` / `<path>` / `<pii>` / `<secret>`。',
      '',
      '**脱敏可能抹掉定位 bug 的关键线索**（例如与用户名或具体路径相关的复现条件）。',
      '',
      '**截图（screenshots/）无法脱敏** —— 它们是画面快照，如含敏感信息请自行处理后再分享。',
    )
  } else {
    lines.push(
      '本包**未脱敏**，包含完整的路径、用户名与环境信息，以便最大程度保留定位 bug 所需的线索。',
      '',
      '分享前请确认其中不含不宜外传的内容。',
    )
  }
  if (interrupted) {
    lines.push(
      '',
      '## 注意：录制被异常中断',
      '',
      '本次录制未经正常停止（应用崩溃或被强制结束），事件流止于中断前的最后一次写入。',
    )
  }
  lines.push('')
  return lines.join('\n')
}

export async function buildBugRecordingArchive(
  input: BugRecordingArchiveInput,
): Promise<BugRecordingResult> {
  const { rawDir, sessionDir, meta, redact, piiPaths } = input
  const interrupted = input.interrupted ?? false
  const zip = new AdmZip()

  const screenshotNames = await listScreenshots(rawDir)
  const packedScreenshots = new Set(screenshotNames)
  for (const name of screenshotNames) {
    const buf = await readFileIfExists(join(rawDir, SCREENSHOTS_DIR, name))
    if (buf !== null) zip.addFile(`${SCREENSHOTS_DIR}/${name}`, buf)
  }

  const rawEvents = (await readFileIfExists(join(rawDir, EVENTS_FILE)))?.toString('utf8') ?? ''
  // Ring-buffer eviction deletes old screenshot files; drop the events pointing
  // at them so the timeline never references something absent from the zip.
  const events: PersistedBugRecordEvent[] = parseEventsJsonl(rawEvents).filter(
    (event) => event.kind !== 'screenshot' || packedScreenshots.has(basename(event.file)),
  )

  const logTails = await collectSessionLogTails(sessionDir, LOG_TAIL_BYTES)
  for (const tail of logTails) {
    const text = redactLines(tail.content.toString('utf8'), redact, piiPaths)
    zip.addFile(`logs/${meta.sessionId}/${tail.name}`, Buffer.from(text, 'utf8'))
  }

  const errors = await readFileIfExists(join(sessionDir, 'errors.jsonl'))
  if (errors !== null) {
    const text = redactLines(errors.toString('utf8'), redact, piiPaths)
    zip.addFile(`errors-${meta.sessionId}.jsonl`, Buffer.from(text, 'utf8'))
  }

  const transcriptFiles: string[] = []
  const transcripts = (input.transcripts ?? []).slice(0, MAX_TRANSCRIPTS)
  for (const [index, transcript] of transcripts.entries()) {
    if (transcript.path === undefined) continue
    const buf = await readFileIfExists(transcript.path)
    if (buf === null) continue
    const capped =
      buf.length > TRANSCRIPT_MAX_BYTES ? buf.subarray(buf.length - TRANSCRIPT_MAX_BYTES) : buf
    const safeTitle = transcript.title.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 60)
    const name = `transcript-${index + 1}-${safeTitle || 'session'}.jsonl`
    zip.addFile(name, Buffer.from(redactLines(capped.toString('utf8'), redact, piiPaths), 'utf8'))
    transcriptFiles.push(name)
  }

  const environment = input.environment
  if (environment !== undefined) {
    zip.addFile('environment.md', Buffer.from(redactLines(environment, redact, piiPaths), 'utf8'))
  }

  if (input.crashDumpsDir !== undefined) {
    const dumps = await listCrashDumps(input.crashDumpsDir)
    const listing = dumps.length > 0 ? `${dumps.join('\n')}\n` : '(no crash dumps)\n'
    zip.addFile('crash-dumps.txt', Buffer.from(redactLines(listing, redact, piiPaths), 'utf8'))
  }

  const eventsText = events.map((event) => JSON.stringify(event)).join('\n')
  const redactedEvents = redactLines(eventsText, redact, piiPaths)
  zip.addFile(EVENTS_FILE, Buffer.from(redactedEvents === '' ? '' : `${redactedEvents}\n`, 'utf8'))

  // Redaction caps line length, so a pathological single line can come back
  // truncated and unparseable. Silent loss would make an incomplete timeline look
  // complete, so count what the timeline could not read and say so in the report.
  const timelineEvents = parseEventsJsonl(redactedEvents)
  const droppedEventLines = Math.max(0, events.length - timelineEvents.length)

  const timeline = buildBugRecordingTimeline({
    events: timelineEvents,
    startedAt: meta.startedAt,
    durationMs: Math.max(0, input.endedAt - meta.startedAt),
    sessionId: meta.sessionId,
    redacted: redact,
    interrupted,
    ...(droppedEventLines > 0 ? { droppedEventLines } : {}),
    ...(meta.workspaceFolders !== undefined
      ? {
          workspaceFolders: meta.workspaceFolders.map((folder) =>
            redactLines(folder, redact, piiPaths),
          ),
        }
      : {}),
    ...(environment !== undefined
      ? { environment: redactLines(environment, redact, piiPaths) }
      : {}),
    ...(transcriptFiles.length > 0 ? { transcriptFiles } : {}),
    logExcerpt: extractLogExcerpt(
      logTails.map((tail) => ({
        name: tail.name,
        text: redactLines(tail.content.toString('utf8'), redact, piiPaths),
      })),
      LOG_EXCERPT_MAX_LINES,
    ),
  })
  zip.addFile('timeline.md', Buffer.from(timeline, 'utf8'))
  zip.addFile('redaction.md', Buffer.from(buildRedactionNotice(redact, interrupted), 'utf8'))

  await fs.mkdir(input.outputDir, { recursive: true })
  const stamp = new Date(meta.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const zipPath = join(input.outputDir, `universe-bug-recording-${stamp}.zip`)
  await zip.writeZipPromise(zipPath)
  const stat = await fs.stat(zipPath).catch(() => null)

  return {
    zipPath,
    eventCount: events.length,
    screenshotCount: screenshotNames.length,
    zipSizeBytes: stat?.size ?? 0,
  }
}
