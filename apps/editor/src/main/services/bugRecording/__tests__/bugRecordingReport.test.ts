/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/bugRecording/bugRecordingReport.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  buildBugRecordingTimeline,
  extractLogExcerpt,
  parseEventsJsonl,
  type BugRecordingReportInput,
} from '../bugRecordingReport.js'
import type {
  BugRecordEvent,
  PersistedBugRecordEvent,
} from '../../../../shared/ipc/bugRecorderService.js'

const STARTED_AT = Date.UTC(2026, 7, 28, 3, 12, 0)
const STARTED_ISO = '2026-08-28T03:12:00.000Z'

function evt(t: number, event: BugRecordEvent): PersistedBugRecordEvent {
  return { ...event, t }
}

function build(
  events: readonly PersistedBugRecordEvent[],
  overrides: Partial<BugRecordingReportInput> = {},
): BugRecordingReportInput {
  return {
    events,
    startedAt: STARTED_AT,
    durationMs: 723000,
    sessionId: 'sess-123',
    redacted: false,
    ...overrides,
  }
}

function summarySection(md: string): string {
  return md.slice(md.indexOf('## 错误汇总'), md.indexOf('## 日志摘录'))
}

describe('buildBugRecordingTimeline', () => {
  it('renders a row per event kind with the expected label and detail', () => {
    const events: PersistedBugRecordEvent[] = [
      evt(3200, {
        ts: 0,
        kind: 'telemetry',
        name: 'commandExecuted',
        data: { commandId: 'workbench.action.openFile' },
      }),
      evt(5500, { ts: 1, kind: 'edit', count: 12, resource: 'X:/workspace/src/a.ts' }),
      evt(12300, {
        ts: 2,
        kind: 'acpMessage',
        sessionId: 'acp-1',
        role: 'user',
        text: '帮我修 a.ts',
      }),
      evt(14800, {
        ts: 3,
        kind: 'acpToolCall',
        sessionId: 'acp-1',
        title: 'Read(src/a.ts)',
        status: 'running',
      }),
      evt(42300, {
        ts: 4,
        kind: 'screenshot',
        file: 'screenshots/0005.jpg',
        reason: 'commandError',
      }),
      evt(42300, {
        ts: 5,
        kind: 'commandError',
        commandId: 'workbench.action.formatDocument',
        message: 'Cannot read properties of undefined',
      }),
      evt(50000, { ts: 6, kind: 'editorSwitch', resource: 'X:/workspace/src/b.ts' }),
      evt(51000, { ts: 7, kind: 'notification', severity: 'warning', message: '磁盘空间不足' }),
      evt(52000, {
        ts: 8,
        kind: 'notification',
        severity: 'error',
        message: '无法保存文件：EACCES',
      }),
      evt(53000, { ts: 9, kind: 'marker' }),
      evt(54000, {
        ts: 10,
        kind: 'telemetry',
        name: 'acp.prompt_sent',
        data: { sessionId: 'acp-1' },
      }),
      evt(55000, {
        ts: 11,
        kind: 'telemetry',
        name: 'some.unknown',
        data: { foo: 'bar', n: 1 },
      }),
      evt(56000, { ts: 12, kind: 'acpMessage', sessionId: 'acp-1', role: 'agent', text: '好的' }),
      evt(56500, { ts: 13, kind: 'acpMessage', sessionId: 'acp-1', role: 'assistant', text: 'x' }),
      evt(57000, {
        ts: 14,
        kind: 'acpMessage',
        sessionId: 'acp-1',
        role: 'thought',
        text: '先读文件',
      }),
      evt(58000, {
        ts: 15,
        kind: 'telemetry',
        name: 'editorOpened',
        data: { resource: 'X:/workspace/src/a.ts' },
      }),
      evt(59000, {
        ts: 16,
        kind: 'telemetry',
        name: 'acp.session_created',
        data: { sessionId: 'acp-1' },
      }),
      evt(60000, { ts: 17, kind: 'telemetry', name: 'acp.tool_call_started' }),
      evt(61000, { ts: 18, kind: 'telemetry', name: 'acp.rewind' }),
    ]
    const md = buildBugRecordingTimeline(build(events))
    expect(md).toContain(
      '> 录制 12 分 03 秒 · 事件 19 条 · 截图 1 张 · 错误命令 1 条 · 错误通知 1 条',
    )
    expect(md).toContain('| 0.0s | 录制开始 | |')
    expect(md).toContain('| 3.2s | 命令执行 | workbench.action.openFile |')
    expect(md).toContain('| 5.5s | 编辑 | a.ts 编辑 12 次 |')
    expect(md).toContain('| 12.3s | ACP | [用户] 帮我修 a.ts |')
    expect(md).toContain('| 14.8s | ACP 工具 | Read(src/a.ts) running |')
    expect(md).toContain('| 42.3s | 截图 | screenshots/0005.jpg（原因: 命令失败） |')
    expect(md).toContain(
      '| 42.3s | ⚠ 命令失败 | workbench.action.formatDocument: Cannot read properties of undefined |',
    )
    expect(md).toContain('| 50.0s | 切换编辑器 | |')
    expect(md).toContain('| 51.0s | 通知[warning] | 磁盘空间不足 |')
    expect(md).toContain('| 52.0s | ⚠ 通知[error] | 无法保存文件：EACCES |')
    expect(md).toContain('| 53.0s | 📌 用户标记 | |')
    expect(md).toContain('| 54.0s | ACP 发送 prompt | sessionId=acp-1 |')
    expect(md).toContain('| 55.0s | 遥测 some.unknown | foo=bar n=1 |')
    expect(md).toContain('| 56.0s | ACP | [助手] 好的 |')
    expect(md).toContain('| 56.5s | ACP | [assistant] x |')
    expect(md).toContain('| 57.0s | ACP | [思考] 先读文件 |')
    expect(md).toContain('| 58.0s | 打开编辑器 | resource=X:/workspace/src/a.ts |')
    expect(md).toContain('| 59.0s | ACP 会话创建 | sessionId=acp-1 |')
    expect(md).toContain('| 60.0s | ACP 工具调用开始 | |')
    expect(md).toContain('| 61.0s | ACP 回退 | |')
    expect(md).toContain(
      '1. (×1) workbench.action.formatDocument → Cannot read properties of undefined',
    )
    expect(md).toContain('2. (×1) 通知[error] 无法保存文件：EACCES')
  })

  it('escapes pipes and newlines so the table structure survives', () => {
    const events: PersistedBugRecordEvent[] = [
      evt(1000, { ts: 0, kind: 'commandError', commandId: 'a|b', message: 'first\nsecond|third' }),
      evt(2000, { ts: 1, kind: 'edit', count: 1, resource: 'X:/workspace/d|e.ts' }),
    ]
    const md = buildBugRecordingTimeline(build(events))
    expect(md).toContain('| 1.0s | ⚠ 命令失败 | a\\|b: first second\\|third |')
    expect(md).toContain('| 2.0s | 编辑 | d\\|e.ts 编辑 1 次 |')
    // 每个表格行仍然恰好是 3 列：未转义的 `|` 才会被切分。
    for (const line of md.split('\n')) {
      if (line.startsWith('| ')) {
        expect(line.split(/(?<!\\)\|/)).toHaveLength(5)
      }
    }
  })

  it('orders timeline rows by t', () => {
    const events: PersistedBugRecordEvent[] = [
      evt(5000, { ts: 1, kind: 'marker' }),
      evt(1000, { ts: 0, kind: 'marker' }),
    ]
    const md = buildBugRecordingTimeline(build(events))
    expect(md.indexOf('| 1.0s |')).toBeLessThan(md.indexOf('| 5.0s |'))
  })

  it('merges the error summary by commandId + message prefix, sorted by count desc', () => {
    const prefix = 'E'.repeat(80)
    const events: PersistedBugRecordEvent[] = [
      evt(1000, { ts: 0, kind: 'commandError', commandId: 'a', message: `${prefix}-x` }),
      evt(2000, { ts: 1, kind: 'commandError', commandId: 'a', message: `${prefix}-y` }),
      evt(3000, { ts: 2, kind: 'commandError', commandId: 'b', message: 'boom' }),
      evt(4000, { ts: 3, kind: 'commandError', commandId: 'a', message: `${prefix}-x` }),
      evt(5000, { ts: 4, kind: 'notification', severity: 'error', message: 'save failed' }),
      evt(6000, { ts: 5, kind: 'notification', severity: 'error', message: 'save failed' }),
      evt(7000, { ts: 6, kind: 'notification', severity: 'warning', message: 'slow' }),
      evt(8000, { ts: 7, kind: 'commandError', commandId: 'c', message: 'single' }),
    ]
    const md = buildBugRecordingTimeline(build(events))
    const summary = summarySection(md)
    expect(summary).toContain(`1. (×3) a → ${prefix}-x`)
    expect(summary).toContain('   - 首次 t=1.0s，最近 t=4.0s')
    expect(summary).toContain('2. (×2) 通知[error] save failed')
    expect(summary).toContain('   - 首次 t=5.0s，最近 t=6.0s')
    expect(summary).toContain('3. (×1) b → boom')
    expect(summary).toContain('4. (×1) c → single')
    expect(summary.match(/^\d+\. \(×/gm)).toHaveLength(4)
    // warning 通知不进错误汇总
    expect(summary).not.toContain('slow')
  })

  it('caps the error summary at 10 entries', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      evt(i * 1000, { ts: i, kind: 'commandError', commandId: `cmd${i}`, message: `msg${i}` }),
    )
    const md = buildBugRecordingTimeline(build(events))
    expect(summarySection(md).match(/^\d+\. \(×/gm)).toHaveLength(10)
  })

  it('formats duration as minutes+seconds, or bare seconds under a minute', () => {
    expect(buildBugRecordingTimeline(build([], { durationMs: 723000 }))).toContain(
      '> 录制 12 分 03 秒',
    )
    expect(buildBugRecordingTimeline(build([], { durationMs: 60000 }))).toContain(
      '> 录制 1 分 00 秒',
    )
    expect(buildBugRecordingTimeline(build([], { durationMs: 45000 }))).toContain('> 录制 45 秒')
    expect(buildBugRecordingTimeline(build([], { durationMs: 9000 }))).toContain('> 录制 9 秒')
  })

  it('produces a valid report for an empty recording', () => {
    const md = buildBugRecordingTimeline(build([], { durationMs: 45000 }))
    expect(md).toContain('# Bug 录制报告')
    expect(md).toContain(`> 开始 ${STARTED_ISO} · 会话 sess-123 · 未脱敏（详见 redaction.md）`)
    expect(md).toContain('> 工作区: (无)')
    expect(md).toContain('(环境信息不可用)')
    expect(md).toContain('| 0.0s | 录制开始 | |')
    expect(md).toContain('## 时间线（t = 距录制开始秒数）')
    expect(md).toContain('## 错误汇总')
    expect(md).toContain('## 日志摘录（error/warn 行，去重）')
    expect(md).toContain('## ACP 对话')
    expect(md).toContain('## 脱敏说明')
    expect(md.match(/\(无\)/g)).toHaveLength(4)
  })

  it('renders redacted and unredacted variants of the note', () => {
    const plain = buildBugRecordingTimeline(build([], { redacted: false }))
    expect(plain).toContain(`> 开始 ${STARTED_ISO} · 会话 sess-123 · 未脱敏（详见 redaction.md）`)
    expect(plain).toContain('本包未脱敏，包含完整的路径与环境信息。')

    const redacted = buildBugRecordingTimeline(build([], { redacted: true }))
    expect(redacted).toContain(
      `> 开始 ${STARTED_ISO} · 会话 sess-123 · 已脱敏（详见 redaction.md）`,
    )
    expect(redacted).toContain(
      '本包除 screenshots/ 外均已脱敏（<user>、<path>、<secret> 掩码）。截图是画面快照，无法脱敏。',
    )
  })

  it('inlines environment, workspace folders, transcripts and log excerpt', () => {
    const md = buildBugRecordingTimeline(
      build([], {
        workspaceFolders: ['X:/workspace', 'X:/workspace-lib'],
        environment: 'OS: Windows 10\nApp: 1.0.0',
        transcriptFiles: ['transcript-1-abc.jsonl', 'transcript-2-def.jsonl'],
        logExcerpt: ['[error] line one', '[error] line two'],
      }),
    )
    expect(md).toContain('> 工作区: X:/workspace, X:/workspace-lib')
    expect(md).toContain('## 环境\n\nOS: Windows 10\nApp: 1.0.0')
    expect(md).toContain('- transcript-1-abc.jsonl（完整对话）')
    expect(md).toContain('- transcript-2-def.jsonl（完整对话）')
    expect(md).toContain('```text\n[error] line one\n[error] line two\n```')
  })

  it('truncates long detail cells to 300 chars with an ellipsis', () => {
    const long = 'x'.repeat(500)
    const md = buildBugRecordingTimeline(
      build([evt(1000, { ts: 0, kind: 'commandError', commandId: 'c', message: long })]),
    )
    const row = md.split('\n').find((l) => l.startsWith('| 1.0s |'))
    expect(row).toBe(`| 1.0s | ⚠ 命令失败 | c: ${'x'.repeat(297)}… |`)
    expect(summarySection(md)).toContain(`1. (×1) c → ${'x'.repeat(296)}…`)
  })
})

describe('parseEventsJsonl', () => {
  it('keeps valid events in order and skips malformed lines', () => {
    const content = [
      JSON.stringify({ ts: 0, kind: 'commandError', t: 1, commandId: 'c', message: 'm' }),
      '',
      'not json',
      '{truncated',
      'null',
      '[1,2,3]',
      '{}',
      JSON.stringify({ kind: 'commandError' }),
      JSON.stringify({ t: 5, commandId: 'c', message: 'm' }),
      JSON.stringify({ ts: 2, kind: 'screenshot', t: 2, file: 'f.jpg', reason: 'marker' }),
      JSON.stringify({ ts: 3, kind: 'edit', t: 3, count: 2 }),
    ].join('\n')
    const events = parseEventsJsonl(content)
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ kind: 'commandError', t: 1 })
    expect(events[1]).toMatchObject({ kind: 'screenshot', t: 2 })
    expect(events[2]).toMatchObject({ kind: 'edit', t: 3 })
  })
})

describe('extractLogExcerpt', () => {
  it('keeps unique error/warn lines in order and caps at the last maxLines', () => {
    const logs = [
      {
        name: 'main.log',
        text: ['[info] ok', '[error] fail a', '[warn] slow b', '[error] fail a'].join('\n'),
      },
      {
        name: 'renderer.log',
        text: ['[info] ok', '[error] fail c', '[warning] dup c', '[error] fail c'].join('\n'),
      },
    ]
    expect(extractLogExcerpt(logs, 10)).toEqual([
      '[error] fail a',
      '[warn] slow b',
      '[error] fail c',
      '[warning] dup c',
    ])
    expect(extractLogExcerpt(logs, 2)).toEqual(['[error] fail c', '[warning] dup c'])
    expect(extractLogExcerpt(logs, 0)).toEqual([])
    expect(extractLogExcerpt([{ name: 'x.log', text: 'all good lines' }], 10)).toEqual([])
  })
})
