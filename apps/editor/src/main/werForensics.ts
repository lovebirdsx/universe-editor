/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Windows-event-log forensics for abnormal exits. When the main process dies
 *  without a crash dump, our own logs just stop mid-stream — the only remaining
 *  evidence lives in the Windows Application event log: Application Error (1000)
 *  and Application Hang (1002) prove a native crash/hang of our exe, WER (1001)
 *  records the report, and their absence points at an external TerminateProcess
 *  (task kill / AV) or power loss. Queried via wevtutil on the launch that
 *  detects the abnormal exit, best-effort with a hard timeout.
 *
 *  Not every 1001 is a death certificate: the same event id carries
 *  RADAR_PRE_LEAK_64, a memory-growth warning Windows logs *before* anything
 *  crashes. Counting it as crash evidence suppresses the "no crash event at all"
 *  verdict, which is the opposite of what it means — so 1001 is classified by its
 *  report name, and an unrecognized name is never promoted to evidence.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process'

export type WerEventKind = 'crash' | 'hang' | 'wer-report' | 'leak-warning' | 'other'

export interface WerEventSummary {
  readonly eventId: number
  readonly provider: string
  /** ISO SystemTime of the event. */
  readonly time: string
  /** First EventData fields, joined — faulting app/module, exception code, etc. */
  readonly detail: string
  readonly kind: WerEventKind
  /** 1001 only: the WER report name from EventData[2] (APPCRASH / RADAR_PRE_LEAK_64 …). */
  readonly reportName: string | undefined
}

const EVENT_LABELS: Record<number, string> = {
  1000: 'Application Error',
  1001: 'Windows Error Reporting',
  1002: 'Application Hang',
}

/**
 * WER's 1001 payload is positional: BucketId | BucketType | EventName | Response |
 * CabId | AppName | AppVersion | OSVersion. Only the position carries the meaning —
 * the fields are localized on non-English systems.
 */
const WER_REPORT_NAME_INDEX = 2
const WER_DATA_FIELD_LIMIT = 8
const LEAK_WARNING_RE = /^RADAR_PRE_LEAK/i
const CRASH_REPORT_RE = /^(?:mo)?app(?:crash|hang|verify)/i

/**
 * Event id alone cannot tell a crash from a warning: 1001 is a container that
 * carries APPCRASH, APPHANG and RADAR_PRE_LEAK_* alike. Anything unrecognized
 * stays `other` — a false "it crashed" is worse than a missing label.
 */
export function classifyWerEvent(eventId: number, reportName: string | undefined): WerEventKind {
  if (eventId === 1000) return 'crash'
  if (eventId === 1002) return 'hang'
  if (eventId !== 1001 || reportName === undefined) return 'other'
  if (LEAK_WARNING_RE.test(reportName)) return 'leak-warning'
  if (CRASH_REPORT_RE.test(reportName)) return 'wer-report'
  return 'other'
}

/** Whether the event proves this process died natively (as opposed to a warning). */
export function isNativeDeathEvidence(kind: WerEventKind): boolean {
  return kind === 'crash' || kind === 'hang' || kind === 'wer-report'
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
    const fields: string[] = []
    for (const m of chunk.matchAll(/<Data(?:\s[^>]*)?>([^<]*)<\/Data>/g)) {
      fields.push((m[1] ?? '').trim())
      if (fields.length >= WER_DATA_FIELD_LIMIT) break
    }
    const reportName = eventId === 1001 ? fields[WER_REPORT_NAME_INDEX] || undefined : undefined
    summaries.push({
      eventId,
      provider,
      time,
      detail: fields.filter((value) => value !== '').join(' | '),
      kind: classifyWerEvent(eventId, reportName),
      reportName,
    })
  }
  return summaries
}

/**
 * Turn a finished query into the contract its callers depend on: `undefined` when
 * the query did not run to completion, the matches otherwise. wevtutil exits 0
 * with empty stdout when nothing matched, so its exit code cannot tell "found
 * nothing" from "never ran" — an empty array is a *successful* query that matched
 * nothing, and must never be read as a verdict on its own.
 */
export function resolveWerQueryResult(
  err: unknown,
  stdout: string | undefined,
  exeName: string,
): WerEventSummary[] | undefined {
  if (err) return undefined
  return parseWerEvents(stdout ?? '', exeName)
}

/**
 * Query the Windows Application event log for crash evidence about this exe
 * since `sinceMs`. Resolves to the matching events; `undefined` when the query
 * never ran (non-Windows, wevtutil failed or timed out) — which is *unknown*,
 * not *no crash*, and must not be read as a verdict. An empty array means the
 * query did run and matched nothing.
 */
export function collectWerEvents(
  exeName: string,
  sinceMs: number,
  timeoutMs = 8000,
): Promise<WerEventSummary[] | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile(
      'wevtutil',
      ['qe', 'Application', `/q:${buildWerQuery(sinceMs)}`, '/f:xml', '/c:40', '/rd:true'],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(resolveWerQueryResult(err, stdout, exeName)),
    )
  })
}
