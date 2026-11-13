/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/abnormalExitConclusion.ts — 2026-09-12 那次是必须
 *  守住的回归形状：泄漏预警不能被读成崩溃，日志自己停住也不能被读成外部终止。
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
    mainExit: undefined,
    previousSessionId: SESSION_ID,
    lastAliveAt: LAST_ALIVE_MS,
    ...overrides,
  }
}

function mainExit(
  exitCode: number,
  exitedAt = LAST_ALIVE_MS,
): NonNullable<AbnormalExitFacts['mainExit']> {
  return {
    pid: 4242,
    exitCode,
    exitCodeHex: `0x${(exitCode >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
    exitedAt,
  }
}

describe('concludeAbnormalExit', () => {
  it('does not attribute the 2026-09-12 shape to an external kill', () => {
    const conclusion = concludeAbnormalExit(facts())
    expect(conclusion.verdict).toBe('indeterminate')
    expect(
      conclusion.lines.some((line) => line.text.includes('likely terminated externally')),
    ).toBe(false)
  })

  it('enumerates the causes an exit without native-death evidence leaves open', () => {
    const verdictLine = concludeAbnormalExit(facts()).lines.at(-1)
    expect(verdictLine?.level).toBe('warn')
    expect(verdictLine?.text).toContain('no native-death evidence')
    expect(verdictLine?.text).toContain('cannot be attributed')
    expect(verdictLine?.text).toContain('an external kill (task kill / antivirus)')
    expect(verdictLine?.text).toContain('shutdown or restart')
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
    expect(verdictLine?.text).toContain('does not explain the exit')
  })

  it('does not turn a user-launched over-threshold process into an editor verdict scene', () => {
    // The user's own backend (node under an integrated-terminal bash) crossed 2GB. It is
    // still in the scene as a footnote, but it is not evidence about the editor's memory.
    const userHeavy = {
      ...parseExitScene(
        [
          '[12:02:56] [info] hosted-processes cnt=2 user:bash.exe#50=20MB/0% | user:node#51=2554MB/0% — above 2048MB: user:node#51',
          '[12:15:22] [info] pid=29676 type=Tab mem=687MB cpu=0%',
        ].join('\n'),
        { sessionStartMs: SESSION_START_MS },
      ),
      source: 'live' as const,
      truncated: false,
    }

    const conclusion = concludeAbnormalExit(facts({ scene: userHeavy }))
    expect(conclusion.record).toContain('scene=calm')
    const sceneLine = conclusion.lines.find((line) =>
      line.text.includes('previous-session log tail'),
    )
    expect(sceneLine?.level).toBe('info')
    expect(sceneLine?.text).toContain('not counted as editor risk')
    expect(conclusion.lines.at(-1)?.text).not.toContain('peaked at')
  })

  it('never lets the memory clause name the cause of death', () => {
    const scene = {
      ...parseExitScene(
        [
          '[12:02:42] [warn] pid=29676 type=Tab mem=2300MB — renderer working set above 2048MB, OOM risk',
          '[12:15:22] [info] pid=29676 type=Tab mem=2600MB cpu=0%',
        ].join('\n'),
        { sessionStartMs: SESSION_START_MS },
      ),
      source: 'live' as const,
      truncated: false,
    }
    const clause = concludeAbnormalExit(facts({ scene }))
      .lines.at(-1)
      ?.text.split('; ')
      .find((part) => part.includes('peaked at'))
    expect(clause).toContain('still over its 2048MB line in the last sample')
    // 内存曲线只是现场事实，不能写成死因
    expect(clause).not.toContain('kill')
    expect(clause).not.toContain('OOM')
    expect(clause).not.toContain('consistent with')
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

  it('keeps "nothing matched" apart from "could not read the log"', () => {
    const none = concludeAbnormalExit(facts({ werEvents: [] }))
    const unknown = concludeAbnormalExit(facts({ werEvents: undefined }))
    expect(none.verdict).toBe('indeterminate')
    expect(unknown.verdict).toBe('indeterminate')
    expect(
      none.lines.some((line) => line.text.includes('no crash/hang/WER event for this exe')),
    ).toBe(true)
    expect(unknown.lines.some((line) => line.text.includes('could not be read'))).toBe(true)
    expect(none.lines.some((line) => line.text.includes('neither ruled in nor ruled out'))).toBe(
      false,
    )
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
    expect(conclusion.verdict).toBe('indeterminate')
    expect(
      conclusion.lines.some(
        (line) =>
          line.level === 'warn' && line.text.includes(`log tail unavailable (${SESSION_ID})`),
      ),
    ).toBe(true)
  })

  it('keeps the record free of values that change between identical deaths', () => {
    const first = concludeAbnormalExit(facts({ mainExit: mainExit(0xc0000005, LAST_ALIVE_MS) }))
    const second = concludeAbnormalExit(
      facts({
        mainExit: mainExit(0xc0000005, LAST_ALIVE_MS + 12_345),
        lastAliveAt: LAST_ALIVE_MS + 90_000,
        previousSessionId: '20260913T090000',
      }),
    )
    expect(first.record).toBe(second.record)
    expect(first.record).toBe(
      'verdict=native-death; platform=win32; wer=leak-warning; dumps=0; scene=renderer-over-threshold; mainExit=native-crash/0xC0000005',
    )
  })

  it('attributes exit code 1 to an external TerminateProcess', () => {
    const conclusion = concludeAbnormalExit(facts({ mainExit: mainExit(1) }))
    expect(conclusion.verdict).toBe('external-kill')
    expect(conclusion.record).toContain('mainExit=external-terminate/0x00000001')
    expect(
      conclusion.lines.some(
        (line) =>
          line.text.includes('external TerminateProcess') && line.text.includes('taskkill /F'),
      ),
    ).toBe(true)
    // 归因要给，但不能把「进程自己 exit(1)」这个形状说死。
    expect(conclusion.lines.some((line) => line.text.includes('would look identical'))).toBe(true)
  })

  it('turns a known NTSTATUS into native-death even without WER evidence', () => {
    const conclusion = concludeAbnormalExit(
      facts({ werEvents: [], mainExit: mainExit(0xc0000005) }),
    )
    expect(conclusion.verdict).toBe('native-death')
    expect(conclusion.record).toContain('mainExit=native-crash/0xC0000005')
    expect(
      conclusion.lines.some(
        (line) =>
          line.level === 'error' &&
          line.text.includes('STATUS_ACCESS_VIOLATION') &&
          line.text.includes('access violation'),
      ),
    ).toBe(true)
    expect(conclusion.lines.some((line) => line.text.includes('not from an external kill'))).toBe(
      true,
    )
  })

  it('names the Chromium OOM termination code', () => {
    const conclusion = concludeAbnormalExit(
      facts({ werEvents: [], mainExit: mainExit(0xe0000008) }),
    )
    expect(conclusion.verdict).toBe('native-death')
    expect(conclusion.record).toContain('mainExit=native-crash/0xE0000008')
    expect(
      conclusion.lines.some(
        (line) => line.text.includes('OOM') && line.text.includes('out of memory'),
      ),
    ).toBe(true)
  })

  it('explains exit code 0 without clean shutdown as a non-crash', () => {
    const conclusion = concludeAbnormalExit(facts({ mainExit: mainExit(0) }))
    expect(conclusion.verdict).toBe('exit-zero')
    expect(conclusion.record).toContain('mainExit=clean/0x00000000')
    const verdictLine = conclusion.lines.at(-1)
    expect(verdictLine?.level).toBe('warn')
    expect(verdictLine?.text).toContain('never reached will-quit')
    expect(verdictLine?.text).toContain('not a crash')
  })

  it('does not invent a cause for an unrecognised exit code', () => {
    const conclusion = concludeAbnormalExit(facts({ mainExit: mainExit(2) }))
    expect(conclusion.verdict).toBe('indeterminate')
    expect(conclusion.record).toContain('mainExit=unknown/0x00000002')
    expect(conclusion.lines.at(-1)?.text).toContain(
      'is not a known crash or external-termination code',
    )
    expect(conclusion.lines.at(-1)?.text).not.toContain('external TerminateProcess')
  })

  it('says a missing watchdog record could be a whole-tree kill or power loss', () => {
    const conclusion = concludeAbnormalExit(facts({ werEvents: [] }))
    expect(conclusion.verdict).toBe('indeterminate')
    expect(conclusion.record).toContain('mainExit=unrecorded')
    expect(
      conclusion.lines.some(
        (line) =>
          line.level === 'warn' &&
          line.text.includes('exit watchdog left no record') &&
          line.text.includes('taskkill /T') &&
          line.text.includes('lost power'),
      ),
    ).toBe(true)
    expect(conclusion.lines.at(-1)?.text).toContain('whole-tree kill')
  })

  it('does not call the watchdog missing when the platform has none', () => {
    const conclusion = concludeAbnormalExit(
      facts({ platform: 'linux', werEvents: [], mainExit: undefined }),
    )
    expect(
      conclusion.lines.some(
        (line) => line.level === 'info' && line.text.includes('not available on linux'),
      ),
    ).toBe(true)
    expect(conclusion.lines.some((line) => line.text.includes('lost power'))).toBe(false)
    expect(conclusion.lines.at(-1)?.text).not.toContain('whole-tree kill')
  })
})
