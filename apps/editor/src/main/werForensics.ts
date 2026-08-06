/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Windows-event-log forensics for abnormal exits. When the main process dies
 *  without a crash dump, our own logs just stop mid-stream — the only remaining
 *  evidence lives in the Windows Application event log: Application Error (1000)
 *  and Application Hang (1002) prove a native crash/hang of our exe, WER (1001)
 *  records the report, and their absence points at an external TerminateProcess
 *  (task kill / AV) or power loss. Queried via wevtutil on the launch that
 *  detects the abnormal exit, best-effort with a hard timeout.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process'

export interface WerEventSummary {
  readonly eventId: number
  readonly provider: string
  /** ISO SystemTime of the event. */
  readonly time: string
  /** First EventData fields, joined — faulting app/module, exception code, etc. */
  readonly detail: string
}

const EVENT_LABELS: Record<number, string> = {
  1000: 'Application Error',
  1001: 'Windows Error Reporting',
  1002: 'Application Hang',
}

export function describeWerEvent(e: WerEventSummary): string {
  const label = EVENT_LABELS[e.eventId] ?? e.provider
  return `Event ${e.eventId} (${label}) at ${e.time}: ${e.detail}`
}

/** XPath filter for wevtutil: crash/hang/WER events since the given epoch ms. */
export function buildWerQuery(sinceMs: number): string {
  const since = new Date(sinceMs).toISOString()
  return `*[System[(EventID=1000 or EventID=1001 or EventID=1002) and TimeCreated[@SystemTime>='${since}']]]`
}

/**
 * Extract events mentioning the given exe from `wevtutil qe ... /f:xml` output.
 * The output is a concatenation of <Event> elements (no root); parsed with
 * string scanning — the shape is fixed and a full XML parser buys nothing here.
 */
export function parseWerEvents(xml: string, exeName: string): WerEventSummary[] {
  const summaries: WerEventSummary[] = []
  const needle = exeName.toLowerCase()
  for (const chunk of xml.split('</Event>')) {
    if (!chunk.includes('<Event ') || !chunk.toLowerCase().includes(needle)) continue
    const eventId = Number(/<EventID(?:\s[^>]*)?>(\d+)<\/EventID>/.exec(chunk)?.[1])
    if (!Number.isFinite(eventId)) continue
    const provider = /<Provider Name='([^']*)'/.exec(chunk)?.[1] ?? ''
    const time = /<TimeCreated SystemTime='([^']*)'/.exec(chunk)?.[1] ?? ''
    const data: string[] = []
    for (const m of chunk.matchAll(/<Data(?:\s[^>]*)?>([^<]+)<\/Data>/g)) {
      const value = m[1]?.trim()
      if (value) data.push(value)
      if (data.length >= 8) break
    }
    summaries.push({ eventId, provider, time, detail: data.join(' | ') })
  }
  return summaries
}

/**
 * Query the Windows Application event log for crash evidence about this exe
 * since `sinceMs`. Resolves to summary lines; empty when nothing matched, the
 * platform is not Windows, or wevtutil failed/timed out (best-effort).
 */
export function collectWindowsCrashForensics(
  exeName: string,
  sinceMs: number,
  timeoutMs = 8000,
): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      'wevtutil',
      ['qe', 'Application', `/q:${buildWerQuery(sinceMs)}`, '/f:xml', '/c:40', '/rd:true'],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve([])
        resolve(parseWerEvents(stdout, exeName).map(describeWerEvent))
      },
    )
  })
}
