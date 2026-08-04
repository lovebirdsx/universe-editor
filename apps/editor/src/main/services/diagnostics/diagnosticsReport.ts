/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure report-building logic for the diagnostics / Report Issue flow:
 *  system-info shape, errors.jsonl aggregation (top fingerprints by count),
 *  and the markdown summary (VSCode IssueReporter-style <details> folding).
 *  Kept electron-free so it is directly unit-testable.
 *--------------------------------------------------------------------------------------------*/

export interface DiagnosticsSystemInfo {
  readonly appVersion: string
  readonly electron: string
  readonly chromium: string
  readonly node: string
  /** e.g. `Windows 10.0.19045 (x64)` / `macOS 14.5 (arm64)`. */
  readonly os: string
  /** e.g. `Intel(R) Core(TM) i7-9700 (8 × 3.0GHz)`. */
  readonly cpus: string
  /** e.g. `16.0GB (free 8.2GB)`. */
  readonly memory: string
  /** dev | release | e2e */
  readonly mode: string
  readonly locale: string
}

export interface DiagnosticsExtensionEntry {
  readonly id: string
  readonly version: string
  readonly source: string
}

export interface ErrorFingerprintAggregate {
  readonly fingerprint: string
  readonly event: string
  readonly source: string
  count: number
  lastTs: number
  lastMessage: string
}

const DEFAULT_TOP_N = 10

/**
 * Fold errors.jsonl content (one JSON record per line) into per-fingerprint
 * aggregates sorted by total count desc. Malformed lines are skipped — the
 * file is appended by a best-effort writer and may end mid-line after a crash.
 */
export function aggregateErrorFingerprints(
  jsonlContent: string,
  topN = DEFAULT_TOP_N,
): ErrorFingerprintAggregate[] {
  const byKey = new Map<string, ErrorFingerprintAggregate>()
  for (const line of jsonlContent.split('\n')) {
    if (!line.trim()) continue
    let record: {
      event?: unknown
      fingerprint?: unknown
      source?: unknown
      count?: unknown
      ts?: unknown
      message?: unknown
    }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record.fingerprint !== 'string' || typeof record.event !== 'string') continue
    const key = `${record.event}|${record.fingerprint}|${typeof record.source === 'string' ? record.source : ''}`
    const count = typeof record.count === 'number' && record.count > 0 ? record.count : 1
    const ts = typeof record.ts === 'number' ? record.ts : 0
    const existing = byKey.get(key)
    if (existing) {
      existing.count += count
      if (ts >= existing.lastTs) {
        existing.lastTs = ts
        existing.lastMessage = typeof record.message === 'string' ? record.message : ''
      }
    } else {
      byKey.set(key, {
        fingerprint: record.fingerprint,
        event: record.event,
        source: typeof record.source === 'string' ? record.source : '',
        count,
        lastTs: ts,
        lastMessage: typeof record.message === 'string' ? record.message : '',
      })
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, topN)
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function buildIssueMarkdown(
  info: DiagnosticsSystemInfo,
  extensions: readonly DiagnosticsExtensionEntry[],
  errorTop: readonly ErrorFingerprintAggregate[],
): string {
  const lines: string[] = []
  lines.push('## 版本')
  lines.push('')
  lines.push(`- 应用版本: ${info.appVersion} (${info.mode})`)
  lines.push(`- Electron: ${info.electron}`)
  lines.push(`- Chromium: ${info.chromium}`)
  lines.push(`- Node.js: ${info.node}`)
  lines.push(`- OS: ${info.os}`)
  lines.push(`- Locale: ${info.locale}`)
  lines.push('')
  lines.push('## 系统信息')
  lines.push('')
  lines.push('| 项目 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| CPUs | ${escapeTableCell(info.cpus)} |`)
  lines.push(`| 内存 | ${escapeTableCell(info.memory)} |`)
  lines.push('')

  lines.push('## 扩展')
  lines.push('')
  if (extensions.length === 0) {
    lines.push('（无已安装扩展）')
  } else {
    lines.push(`<details><summary>已安装扩展 (${extensions.length})</summary>`)
    lines.push('')
    lines.push('| 扩展 | 版本 | 来源 |')
    lines.push('| --- | --- | --- |')
    for (const ext of extensions) {
      lines.push(
        `| ${escapeTableCell(ext.id)} | ${escapeTableCell(ext.version)} | ${escapeTableCell(ext.source)} |`,
      )
    }
    lines.push('')
    lines.push('</details>')
  }
  lines.push('')

  lines.push('## 近期错误聚合（本地 errors.jsonl）')
  lines.push('')
  if (errorTop.length === 0) {
    lines.push('（近期无错误记录）')
  } else {
    lines.push(`<details><summary>按出现次数排序的 Top ${errorTop.length} 错误指纹</summary>`)
    lines.push('')
    lines.push('| 次数 | 事件 | 指纹 | 来源 | 最近消息 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const e of errorTop) {
      lines.push(
        `| ${e.count} | ${escapeTableCell(e.event)} | ${escapeTableCell(e.fingerprint)} | ${escapeTableCell(e.source)} | ${escapeTableCell(e.lastMessage.slice(0, 120))} |`,
      )
    }
    lines.push('')
    lines.push('</details>')
  }
  lines.push('')
  return lines.join('\n')
}
