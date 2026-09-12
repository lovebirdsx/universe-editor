/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/werForensics.ts — wevtutil XML parsing.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  buildWerQuery,
  classifyWerEvent,
  describeWerEvent,
  isNativeDeathEvidence,
  parseWerEvents,
  resolveWerQueryResult,
} from '../werForensics.js'

const CRASH_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><Level>2</Level><TimeCreated SystemTime='2026-08-06T12:37:59.123456700Z'/><Channel>Application</Channel><Computer>DESKTOP-TEST</Computer></System><EventData><Data>Universe Editor.exe</Data><Data>1.0.0.0</Data><Data>ntdll.dll</Data><Data>10.0.00000.0000</Data><Data>c0000005</Data><Data>000000000009d7f4</Data></EventData></Event>`

const HANG_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Hang'/><EventID Qualifiers='0'>1002</EventID><TimeCreated SystemTime='2026-08-06T12:35:00.000000000Z'/></System><EventData><Data>Universe Editor.exe</Data><Data>1.0</Data><Data>4a2c</Data></EventData></Event>`

const OTHER_APP_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><TimeCreated SystemTime='2026-08-06T11:00:00.000000000Z'/></System><EventData><Data>notepad.exe</Data><Data>c0000005</Data></EventData></Event>`

/**
 * 1001 is a container, not a verdict: this one carries a memory-growth warning.
 * Field order is WER's positional schema (BucketId | BucketType | EventName |
 * Response | CabId | AppName | AppVersion | OSVersion) followed by the empty
 * trailing fields real events have.
 */
const LEAK_WARNING_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Windows Error Reporting'/><EventID Qualifiers='0'>1001</EventID><Level>4</Level><TimeCreated SystemTime='2026-09-12T04:01:31.542345500Z'/><Channel>Application</Channel><Computer>DESKTOP-TEST</Computer></System><EventData><Data>1000000000000000000</Data><Data>5</Data><Data>RADAR_PRE_LEAK_64</Data><Data>不可用</Data><Data>0</Data><Data>Universe Editor.exe</Data><Data>0.14.3.0</Data><Data>10.0.19045.2.0.0</Data><Data></Data><Data></Data><Data></Data><Data></Data></EventData></Event>`

const WER_CRASH_REPORT_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Windows Error Reporting'/><EventID Qualifiers='0'>1001</EventID><TimeCreated SystemTime='2026-08-06T12:38:01.000000000Z'/></System><EventData><Data>1000000000000000001</Data><Data>1</Data><Data>APPCRASH</Data><Data>不可用</Data><Data>0</Data><Data>Universe Editor.exe</Data><Data>1.0.0.0</Data><Data>10.0.00000.0000</Data></EventData></Event>`

const MO_APPCRASH_REPORT_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Windows Error Reporting'/><EventID Qualifiers='0'>1001</EventID><TimeCreated SystemTime='2026-08-06T12:39:01.000000000Z'/></System><EventData><Data>1000000000000000002</Data><Data>1</Data><Data>MoAppCrash</Data><Data>不可用</Data><Data>0</Data><Data>Universe Editor.exe</Data></EventData></Event>`

const UNKNOWN_REPORT_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Windows Error Reporting'/><EventID Qualifiers='0'>1001</EventID><TimeCreated SystemTime='2026-08-06T12:40:01.000000000Z'/></System><EventData><Data>1000000000000000003</Data><Data>5</Data><Data>SOME_FUTURE_REPORT_KIND</Data><Data>不可用</Data><Data>0</Data><Data>Universe Editor.exe</Data></EventData></Event>`

/**
 * The real 1001 payload is 23 fields long; everything past the eighth is WER's
 * own residue, and one of those fields is a temp path under the user profile.
 * `WER_DATA_FIELD_LIMIT` is the only thing keeping it out of main.log and the
 * diagnostics bundle — this test is what holds that limit in place.
 */
const REAL_RESIDUE_PATH = String.raw`\\?\C:\Users\testuser\AppData\Local\Temp\RDR9C8E.tmp\empty.txt`

const REAL_SHAPE_LEAK_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Windows Error Reporting'/><EventID Qualifiers='0'>1001</EventID><Level>4</Level><TimeCreated SystemTime='2026-09-12T04:01:31.5423455Z'/></System><EventData><Data>1700299739708886480</Data><Data>5</Data><Data>RADAR_PRE_LEAK_64</Data><Data>不可用</Data><Data>0</Data><Data>Universe Editor.exe</Data><Data>0.14.3.0</Data><Data>10.0.19045.2.0.0</Data><Data></Data><Data></Data><Data></Data><Data></Data><Data></Data><Data></Data><Data></Data><Data>${REAL_RESIDUE_PATH}</Data><Data></Data><Data></Data><Data>0</Data><Data>0aa890ef-f7eb-4a3a-b34d-a2368b653add</Data><Data>268435456</Data><Data>ae5cb9ab7495a9cb3798ad9acd098dd0</Data><Data>0</Data></EventData></Event>`

describe('werForensics', () => {
  it('parses crash events for the exe and extracts id/provider/time/detail', () => {
    const events = parseWerEvents(CRASH_EVENT + HANG_EVENT, 'Universe Editor.exe')
    expect(events).toHaveLength(2)
    const crash = events[0]
    expect(crash?.eventId).toBe(1000)
    expect(crash?.provider).toBe('Application Error')
    expect(crash?.time).toBe('2026-08-06T12:37:59.123456700Z')
    expect(crash?.detail).toContain('Universe Editor.exe')
    expect(crash?.detail).toContain('c0000005')
    expect(events[1]?.eventId).toBe(1002)
  })

  it('ignores events from other executables', () => {
    const events = parseWerEvents(OTHER_APP_EVENT + CRASH_EVENT, 'Universe Editor.exe')
    expect(events).toHaveLength(1)
    expect(events[0]?.eventId).toBe(1000)
    expect(events[0]?.detail).toContain('Universe Editor.exe')
  })

  it('matches the exe name case-insensitively', () => {
    expect(parseWerEvents(CRASH_EVENT, 'universe editor.EXE')).toHaveLength(1)
  })

  it('returns nothing for empty or unrelated output', () => {
    expect(parseWerEvents('', 'Universe Editor.exe')).toEqual([])
    expect(parseWerEvents('<xml>junk</xml>', 'Universe Editor.exe')).toEqual([])
  })

  it('builds an XPath filtering by event ids and ISO since-time', () => {
    const q = buildWerQuery(Date.UTC(2026, 7, 5, 12, 12, 56))
    expect(q).toContain('EventID=1000')
    expect(q).toContain('EventID=1001')
    expect(q).toContain('EventID=1002')
    expect(q).toContain("@SystemTime>='2026-08-05T12:12:56.000Z'")
  })

  it('describes events with a friendly label', () => {
    const [crash] = parseWerEvents(CRASH_EVENT, 'Universe Editor.exe')
    expect(crash && describeWerEvent(crash)).toMatch(
      /^Event 1000 \(Application Error\) at 2026-08-06T12:37:59/,
    )
  })

  it('classifies 1001 by its report name instead of the event id', () => {
    const leak = parseWerEvents(LEAK_WARNING_EVENT, 'Universe Editor.exe')[0]
    expect(leak?.kind).toBe('leak-warning')
    expect(leak?.reportName).toBe('RADAR_PRE_LEAK_64')

    const appCrash = parseWerEvents(WER_CRASH_REPORT_EVENT, 'Universe Editor.exe')[0]
    expect(appCrash?.kind).toBe('wer-report')
    expect(appCrash?.reportName).toBe('APPCRASH')

    const moAppCrash = parseWerEvents(MO_APPCRASH_REPORT_EVENT, 'Universe Editor.exe')[0]
    expect(moAppCrash?.kind).toBe('wer-report')
  })

  it('keeps the 1001 detail positional when trailing Data fields are empty', () => {
    const leak = parseWerEvents(LEAK_WARNING_EVENT, 'Universe Editor.exe')[0]
    expect(leak?.detail.split(' | ')).toHaveLength(8)
    expect(leak?.detail).toContain('RADAR_PRE_LEAK_64')
    expect(leak?.detail).toContain('Universe Editor.exe')
  })

  it('leaves reportName undefined for 1000 and 1002', () => {
    const events = parseWerEvents(CRASH_EVENT + HANG_EVENT, 'Universe Editor.exe')
    expect(events[0]?.reportName).toBeUndefined()
    expect(events[1]?.reportName).toBeUndefined()
    expect(events[0]?.kind).toBe('crash')
    expect(events[1]?.kind).toBe('hang')
  })

  it('never promotes an unrecognized 1001 to crash evidence', () => {
    const unknown = parseWerEvents(UNKNOWN_REPORT_EVENT, 'Universe Editor.exe')[0]
    expect(unknown?.kind).toBe('other')
    expect(unknown && isNativeDeathEvidence(unknown.kind)).toBe(false)
  })

  it('classifies without an event to parse', () => {
    expect(classifyWerEvent(1000, undefined)).toBe('crash')
    expect(classifyWerEvent(1002, undefined)).toBe('hang')
    expect(classifyWerEvent(1001, undefined)).toBe('other')
    expect(classifyWerEvent(1001, 'RADAR_PRE_LEAK_32')).toBe('leak-warning')
    expect(classifyWerEvent(1001, 'AppHang')).toBe('wer-report')
    expect(classifyWerEvent(1234, 'APPCRASH')).toBe('other')
    expect(isNativeDeathEvidence('wer-report')).toBe(true)
    expect(isNativeDeathEvidence('leak-warning')).toBe(false)
    expect(isNativeDeathEvidence('other')).toBe(false)
  })

  it('never lets the trailing WER residue fields reach the detail', () => {
    const leak = parseWerEvents(REAL_SHAPE_LEAK_EVENT, 'Universe Editor.exe')[0]
    expect(leak?.detail.split(' | ')).toHaveLength(8)
    expect(leak?.detail).not.toContain('testuser')
    expect(leak?.detail).not.toContain('RDR9C8E')
  })

  it('separates a query that failed from one that matched nothing', () => {
    const exe = 'Universe Editor.exe'
    expect(resolveWerQueryResult(new Error('ENOENT'), undefined, exe)).toBeUndefined()
    expect(resolveWerQueryResult(null, '', exe)).toEqual([])
    expect(resolveWerQueryResult(null, CRASH_EVENT, exe)).toHaveLength(1)
  })
})
