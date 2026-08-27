/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/werForensics.ts — wevtutil XML parsing.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { buildWerQuery, describeWerEvent, parseWerEvents } from '../werForensics.js'

const CRASH_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><Level>2</Level><TimeCreated SystemTime='2026-08-06T12:37:59.123456700Z'/><Channel>Application</Channel><Computer>DESKTOP-TEST</Computer></System><EventData><Data>Universe Editor.exe</Data><Data>1.0.0.0</Data><Data>ntdll.dll</Data><Data>10.0.00000.0000</Data><Data>c0000005</Data><Data>000000000009d7f4</Data></EventData></Event>`

const HANG_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Hang'/><EventID Qualifiers='0'>1002</EventID><TimeCreated SystemTime='2026-08-06T12:35:00.000000000Z'/></System><EventData><Data>Universe Editor.exe</Data><Data>1.0</Data><Data>4a2c</Data></EventData></Event>`

const OTHER_APP_EVENT = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><TimeCreated SystemTime='2026-08-06T11:00:00.000000000Z'/></System><EventData><Data>notepad.exe</Data><Data>c0000005</Data></EventData></Event>`

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
})
