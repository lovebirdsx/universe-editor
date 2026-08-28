/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure report-building logic for the bug recording evidence bundle: timeline.md
 *  generation from persisted recording events (the primary consumer is an AI
 *  doing root-cause analysis, so density and parseable structure beat prose),
 *  events.jsonl parsing and log-tail error/warn line extraction.
 *  Kept electron-free so it is directly unit-testable.
 *--------------------------------------------------------------------------------------------*/

import type {
  BugScreenshotReason,
  PersistedBugRecordEvent,
} from '../../../shared/ipc/bugRecorderService.js'

export interface BugRecordingReportInput {
  readonly events: readonly PersistedBugRecordEvent[]
  readonly startedAt: number
  readonly durationMs: number
  readonly sessionId: string
  readonly redacted: boolean
  /** 录制被崩溃/强杀中断，而非用户正常停止。 */
  readonly interrupted?: boolean
  readonly workspaceFolders?: readonly string[]
  /** environment.md 的内容，内联进报告的「环境」节 */
  readonly environment?: string
  /** 打包进 zip 的 ACP transcript 文件名清单 */
  readonly transcriptFiles?: readonly string[]
  /** 日志摘录：已抽好的 error/warn 行（调用方负责抽取，本模块只排版） */
  readonly logExcerpt?: readonly string[]
  /** 解析 events.jsonl 时被跳过的坏行数（脱敏截断超长行所致），非 0 时在报告里声明 */
  readonly droppedEventLines?: number
}

const MAX_DETAIL_LENGTH = 300
const MAX_SUMMARY_ENTRIES = 10
const SUMMARY_MESSAGE_KEY_LENGTH = 80

const TELEMETRY_LABELS: Readonly<Record<string, string>> = {
  commandExecuted: '命令执行',
  editorOpened: '打开编辑器',
  'acp.prompt_sent': 'ACP 发送 prompt',
  'acp.session_created': 'ACP 会话创建',
  'acp.tool_call_started': 'ACP 工具调用开始',
  'acp.rewind': 'ACP 回退',
}

const ACP_ROLE_LABELS: Readonly<Record<string, string>> = {
  user: '用户',
  agent: '助手',
  thought: '思考',
}

const SCREENSHOT_REASON_LABELS: Readonly<Record<BugScreenshotReason, string>> = {
  start: '录制开始',
  commandError: '命令失败',
  errorNotification: '错误通知',
  agentPrompt: 'Agent prompt',
  marker: '用户标记',
}

function formatSeconds(t: number): string {
  return `${(t / 1000).toFixed(1)}s`
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds} 秒`
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
}

function truncate(text: string): string {
  if (text.length <= MAX_DETAIL_LENGTH) return text
  return `${text.slice(0, MAX_DETAIL_LENGTH)}…`
}

// `|` 会打断表格列、换行会截断行，入格前先转义。
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function basename(resource: string): string {
  const parts = resource.split(/[/\\]/)
  return parts[parts.length - 1] ?? resource
}

function resourceDisplay(resource: string | undefined): string {
  if (resource === undefined || resource === '') return '(未知文件)'
  return basename(resource)
}

function flattenTelemetryData(data?: Readonly<Record<string, string | number | boolean>>): string {
  if (data === undefined) return ''
  return Object.entries(data)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}

interface EventRow {
  readonly label: string
  readonly detail: string
}

function timelineRow(t: number, label: string, detail: string): string {
  const escapedDetail = escapeTableCell(detail)
  return `| ${formatSeconds(t)} | ${escapeTableCell(label)} |${escapedDetail === '' ? ' |' : ` ${escapedDetail} |`}`
}

function renderTelemetry(
  name: string,
  data?: Readonly<Record<string, string | number | boolean>>,
): EventRow {
  const label = TELEMETRY_LABELS[name]
  if (label === undefined) {
    return { label: `遥测 ${name}`, detail: flattenTelemetryData(data) }
  }
  if (name === 'commandExecuted') {
    return { label, detail: typeof data?.commandId === 'string' ? data.commandId : '' }
  }
  // Flatten rather than pick named fields: a call site that adds a dimension
  // should show up here instead of silently rendering an empty detail.
  return { label, detail: flattenTelemetryData(data) }
}

function renderEventRow(event: PersistedBugRecordEvent): EventRow {
  switch (event.kind) {
    case 'commandError':
      return { label: '⚠ 命令失败', detail: truncate(`${event.commandId}: ${event.message}`) }
    case 'telemetry':
      return renderTelemetry(event.name, event.data)
    case 'edit':
      return {
        label: '编辑',
        detail: truncate(`${resourceDisplay(event.resource)} 编辑 ${event.count} 次`),
      }
    case 'editorSwitch':
      return { label: '切换编辑器', detail: '' }
    case 'notification':
      return {
        label: event.severity === 'error' ? '⚠ 通知[error]' : '通知[warning]',
        detail: truncate(event.message),
      }
    case 'acpMessage':
      return {
        label: 'ACP',
        detail: truncate(`[${ACP_ROLE_LABELS[event.role] ?? event.role}] ${event.text}`),
      }
    case 'acpToolCall': {
      const detail = [event.title, event.status]
        .filter((part): part is string => part !== undefined)
        .join(' ')
      return { label: 'ACP 工具', detail: truncate(detail) }
    }
    case 'marker':
      return { label: '📌 用户标记', detail: '' }
    case 'screenshot':
      return {
        label: '截图',
        detail: truncate(`${event.file}（原因: ${SCREENSHOT_REASON_LABELS[event.reason]}）`),
      }
    default: {
      // 未来版本新增的 kind 仍要能渲染出行，而不是让整份报告崩掉。
      const unknown = event as { kind: string }
      return { label: unknown.kind, detail: '' }
    }
  }
}

interface ErrorSummaryEntry {
  count: number
  firstT: number
  lastT: number
  title: string
}

function buildErrorSummary(events: readonly PersistedBugRecordEvent[]): ErrorSummaryEntry[] {
  const byKey = new Map<string, ErrorSummaryEntry>()
  for (const event of events) {
    if (event.kind === 'commandError') {
      const key = `command|${event.commandId}|${event.message.slice(0, SUMMARY_MESSAGE_KEY_LENGTH)}`
      const existing = byKey.get(key)
      if (existing) {
        existing.count += 1
        existing.lastT = event.t
        existing.title = `${event.commandId} → ${event.message}`
      } else {
        byKey.set(key, {
          count: 1,
          firstT: event.t,
          lastT: event.t,
          title: `${event.commandId} → ${event.message}`,
        })
      }
    } else if (event.kind === 'notification' && event.severity === 'error') {
      const key = `notification|${event.message.slice(0, SUMMARY_MESSAGE_KEY_LENGTH)}`
      const existing = byKey.get(key)
      if (existing) {
        existing.count += 1
        existing.lastT = event.t
        existing.title = `通知[error] ${event.message}`
      } else {
        byKey.set(key, {
          count: 1,
          firstT: event.t,
          lastT: event.t,
          title: `通知[error] ${event.message}`,
        })
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, MAX_SUMMARY_ENTRIES)
}

export function buildBugRecordingTimeline(input: BugRecordingReportInput): string {
  const lines: string[] = []
  const events = [...input.events].sort((a, b) => a.t - b.t)
  const screenshotCount = events.filter((e) => e.kind === 'screenshot').length
  const commandErrorCount = events.filter((e) => e.kind === 'commandError').length
  const errorNotificationCount = events.filter(
    (e) => e.kind === 'notification' && e.severity === 'error',
  ).length

  lines.push('# Bug 录制报告')
  lines.push('')
  lines.push(
    `> 录制 ${formatDuration(input.durationMs)} · 事件 ${events.length} 条 · 截图 ${screenshotCount} 张 · 错误命令 ${commandErrorCount} 条 · 错误通知 ${errorNotificationCount} 条`,
  )
  lines.push(
    `> 开始 ${new Date(input.startedAt).toISOString()} · 会话 ${input.sessionId} · ${input.redacted ? '已脱敏' : '未脱敏'}（详见 redaction.md）`,
  )
  if (input.interrupted === true) {
    lines.push('> ⚠ 本次录制被异常中断（崩溃或强制结束），事件流止于中断前最后一次写入')
  }
  const dropped = input.droppedEventLines ?? 0
  if (dropped > 0) {
    lines.push(`> ⚠ ${dropped} 行事件无法解析已跳过（多为脱敏截断超长行所致），时间线并不完整`)
  }
  const folders = input.workspaceFolders
  lines.push(
    `> 工作区: ${folders !== undefined && folders.length > 0 ? folders.join(', ') : '(无)'}`,
  )
  lines.push('')

  lines.push('## 环境')
  lines.push('')
  const environment = input.environment?.trim() ?? ''
  lines.push(environment !== '' ? environment : '(环境信息不可用)')
  lines.push('')

  lines.push('## 时间线（t = 距录制开始秒数）')
  lines.push('')
  lines.push('| t | 事件 | 详情 |')
  lines.push('| --- | --- | --- |')
  lines.push(timelineRow(0, '录制开始', ''))
  for (const event of events) {
    const row = renderEventRow(event)
    lines.push(timelineRow(event.t, row.label, row.detail))
  }
  lines.push('')

  lines.push('## 错误汇总')
  lines.push('')
  const summary = buildErrorSummary(events)
  if (summary.length === 0) {
    lines.push('(无)')
  } else {
    summary.forEach((entry, index) => {
      lines.push(`${index + 1}. (×${entry.count}) ${escapeTableCell(truncate(entry.title))}`)
      if (entry.count > 1) {
        lines.push(
          `   - 首次 t=${formatSeconds(entry.firstT)}，最近 t=${formatSeconds(entry.lastT)}`,
        )
      }
    })
  }
  lines.push('')

  lines.push('## 日志摘录（error/warn 行，去重）')
  lines.push('')
  const logExcerpt = input.logExcerpt ?? []
  if (logExcerpt.length === 0) {
    lines.push('(无)')
  } else {
    lines.push('```text')
    lines.push(...logExcerpt)
    lines.push('```')
  }
  lines.push('')

  lines.push('## ACP 对话')
  lines.push('')
  const transcriptFiles = input.transcriptFiles ?? []
  if (transcriptFiles.length === 0) {
    lines.push('(无)')
  } else {
    for (const file of transcriptFiles) {
      lines.push(`- ${file}（完整对话）`)
    }
  }
  lines.push('')

  lines.push('## 脱敏说明')
  lines.push('')
  lines.push(
    input.redacted
      ? '本包除 screenshots/ 外均已脱敏（<user>、<path>、<secret> 掩码）。截图是画面快照，无法脱敏。'
      : '本包未脱敏，包含完整的路径与环境信息。',
  )
  lines.push('')
  return lines.join('\n')
}

export function parseEventsJsonl(content: string): PersistedBugRecordEvent[] {
  const events: PersistedBugRecordEvent[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let record: { kind?: unknown; t?: unknown } | null
    try {
      record = JSON.parse(line) as { kind?: unknown; t?: unknown } | null
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue
    if (typeof record.kind !== 'string' || typeof record.t !== 'number') continue
    events.push(record as PersistedBugRecordEvent)
  }
  return events
}

const LOG_ERROR_OR_WARN = /error|warn/i

export function extractLogExcerpt(
  logs: readonly { name: string; text: string }[],
  maxLines: number,
): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const log of logs) {
    for (const raw of log.text.split('\n')) {
      const line = raw.trim()
      if (line === '' || !LOG_ERROR_OR_WARN.test(line) || seen.has(line)) continue
      seen.add(line)
      lines.push(line)
    }
  }
  return maxLines <= 0 ? [] : lines.slice(-maxLines)
}
