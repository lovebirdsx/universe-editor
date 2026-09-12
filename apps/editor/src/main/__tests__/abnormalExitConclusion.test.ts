/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/abnormalExitConclusion.ts — the 2026-09-12
 *  shape is the regression that matters: a leak warning must not read as a crash,
 *  and the verdict must still name the memory line the dead session was over.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { concludeAbnormalExit, type AbnormalExitFacts } from '../abnormalExitConclusion.js'
import { parseExitScene } from '../exitSceneForensics.js'
import { parseWerEvents } from '../werForensics.js'

const SESSION_ID = '20260912T111811'
const SESSION_START_MS = new Date(2026, 8, 12, 11, 18, 11).getTime()
const LAST_ALIVE_MS = new Date(2026, 8, 12, 12, 15, 21).getTime()

const EXE = 'Universe Editor.exe'

const LEAK_WARNING_XML = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Windows Error Reporting'/><EventID Qualifiers='0'>1001</EventID><TimeCreated SystemTime='2026-09-12T04:01:31.542345500Z'/></System><EventData><Data>1000000000000000000</Data><Data>5</Data><Data>RADAR_PRE_LEAK_64</Data><Data>Unavailable</Data><Data>0</Data><Data>Universe Editor.exe</Data><Data>0.14.3.0</Data><Data>10.0.19045.2.0.0</Data></EventData></Event>`

const CRASH_XML = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><TimeCreated SystemTime='2026-09-12T04:15:21.000000000Z'/></System><EventData><Data>Universe Editor.exe</Data><Data>0.14.3.0</Data><Data>ntdll.dll</Data><Data>10.0.19045.2.0.0</Data><Data>c0000005</Data></EventData></Event>`

const SCENE_LOG = [
  '[12:02:42] [warn] pid=29676 type=Tab mem=2300MB — renderer working set above 2048MB, OOM risk',
  '[12:02:56] [warn] hosted-processes cnt=71 window (window-4)#29676=2623MB/0% — above 2048MB: window (window-4)#29676',
  '[12:10:42] [warn] pid=29676 type=Tab mem=2724MB — renderer working set above 2048MB, OOM risk',
  '[12:15:22] [info] pid=26688 type=Browser mem=302MB cpu=0% | pid=29676 type=Tab mem=687MB cpu=0%',
].join('\n')

function scene(): AbnormalExitFacts['scene'] {
  return {
    ...parseExitScene(SCENE_LOG, { sessionStartMs: SESSION_START_MS }),
    source: 'live',
    truncated: false,
  }
}

function facts(overrides: Partial<AbnormalExitFacts> = {}): AbnormalExitFacts {
  return {
    crashDumpCount: 0,
    platform: 'win32',
    werEvents: parseWerEvents(LEAK_WARNING_XML, EXE),
    scene: scene(),
    previousSessionId: SESSION_ID,
    lastAliveAt: LAST_ALIVE_MS,
    ...overrides,
  }
}

describe('concludeAbnormalExit', () => {
  it('calls the 2026-09-12 shape an external termination, not a crash', () => {
    const conclusion = concludeAbnormalExit(facts())
    expect(conclusion.verdict).toBe('external-termination')
    expect(
      conclusion.lines.some(
        (line) => line.level === 'warn' && line.text.includes('likely terminated externally'),
      ),
    ).toBe(true)
  })

  it('keeps the leak warning out of the error level', () => {
    const conclusion = concludeAbnormalExit(facts())
    const precursor = conclusion.lines.find((line) => line.text.includes('RADAR_PRE_LEAK_64'))
    expect(precursor?.level).toBe('warn')
    expect(precursor?.text).toContain('precursor (not crash evidence)')
    expect(conclusion.lines.filter((line) => line.level === 'error')).toEqual([])
  })

  it('ties the precursor and the memory line into the verdict line', () => {
    const conclusion = concludeAbnormalExit(facts())
    const verdictLine = conclusion.lines.at(-1)
    expect(verdictLine?.text).toContain('only non-fatal WER reports')
    expect(verdictLine?.text).toContain('RADAR_PRE_LEAK_64')
    expect(verdictLine?.text).toContain('window-4')
    expect(verdictLine?.text).toContain('2724MB')
    expect(verdictLine?.text).toContain('2048MB line')
  })

  it('does not claim the process was still over its line once it came back down', () => {
    const verdictLine = concludeAbnormalExit(facts()).lines.at(-1)
    // The real tail ends at 687MB, four minutes after the last over-threshold
    // sample: "still over its line" would have pointed the whole post-mortem at
    // an OOM kill the data does not support.
    expect(verdictLine?.text).not.toContain('still over its')
    expect(verdictLine?.text).toContain('the final sample read 687MB')
    expect(verdictLine?.text).toContain('does not explain the kill')
  })

  it('says the process died over its line when the last sample says so', () => {
    const text = [
      '[12:02:42] [warn] pid=29676 type=Tab mem=2300MB — renderer working set above 2048MB, OOM risk',
      '[12:15:22] [info] pid=29676 type=Tab mem=2600MB cpu=0%',
    ].join('\n')
    const scene = {
      ...parseExitScene(text, { sessionStartMs: SESSION_START_MS }),
      source: 'live' as const,
      truncated: false,
    }
    const verdictLine = concludeAbnormalExit(facts({ scene })).lines.at(-1)
    expect(verdictLine?.text).toContain('still over its 2048MB line in the last sample')
  })

  it('does not echo a malformed session id into the log', () => {
    const conclusion = concludeAbnormalExit(
      facts({ scene: undefined, previousSessionId: 'x\n[error] forged' }),
    )
    expect(conclusion.lines.some((line) => line.text.includes('forged'))).toBe(false)
    expect(conclusion.lines.some((line) => line.text.includes('unknown session'))).toBe(true)
  })

  it('reports a native death when the event log has a crash record', () => {
    const conclusion = concludeAbnormalExit(facts({ werEvents: parseWerEvents(CRASH_XML, EXE) }))
    expect(conclusion.verdict).toBe('native-death')
    expect(conclusion.lines.some((line) => line.level === 'error')).toBe(true)
    expect(
      conclusion.lines.some((line) => line.text.includes('likely terminated externally')),
    ).toBe(false)
  })

  it('reports a native death when a crash dump exists', () => {
    const conclusion = concludeAbnormalExit(facts({ crashDumpCount: 1, werEvents: undefined }))
    expect(conclusion.verdict).toBe('native-death')
    expect(conclusion.record).toContain('dumps=1')
  })

  it('keeps the original wording when the event log matched nothing at all', () => {
    const conclusion = concludeAbnormalExit(facts({ werEvents: [] }))
    expect(conclusion.verdict).toBe('external-termination')
    expect(
      conclusion.lines.some((line) => line.text.includes('no crash/hang/WER event for this exe')),
    ).toBe(true)
  })

  it('never claims an external kill when the event log could not be read', () => {
    const conclusion = concludeAbnormalExit(facts({ werEvents: undefined }))
    expect(conclusion.verdict).toBe('indeterminate')
    expect(
      conclusion.lines.some((line) => line.text.includes('likely terminated externally')),
    ).toBe(false)
    expect(
      conclusion.lines.some((line) => line.text.includes('neither ruled in nor ruled out')),
    ).toBe(true)
  })

  it('says which platform skipped the event log', () => {
    const conclusion = concludeAbnormalExit(facts({ platform: 'darwin', werEvents: undefined }))
    expect(conclusion.verdict).toBe('indeterminate')
    expect(conclusion.lines.some((line) => line.text.includes('not consulted on darwin'))).toBe(
      true,
    )
  })

  it('surfaces a missing scene without changing the verdict', () => {
    const conclusion = concludeAbnormalExit(facts({ scene: undefined }))
    expect(conclusion.verdict).toBe('external-termination')
    expect(
      conclusion.lines.some(
        (line) =>
          line.level === 'warn' && line.text.includes(`log tail unavailable (${SESSION_ID})`),
      ),
    ).toBe(true)
  })

  it('keeps the record free of values that change between identical deaths', () => {
    const first = concludeAbnormalExit(facts())
    const second = concludeAbnormalExit(
      facts({ lastAliveAt: LAST_ALIVE_MS + 90_000, previousSessionId: '20260913T090000' }),
    )
    expect(first.record).toBe(second.record)
    expect(first.record).toBe(
      'verdict=external-termination; platform=win32; wer=leak-warning; dumps=0; scene=renderer-over-threshold',
    )
  })
})
