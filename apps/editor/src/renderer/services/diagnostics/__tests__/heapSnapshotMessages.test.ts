/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/diagnostics/heapSnapshotMessages.ts
 *  main 只发 code 和数字，从不发散文。这里守的失败是「code 到了 renderer 却没产出任何文案」：
 *  用户已经同意了几秒的冻结，而一次空白提示是唯一能让这份同意白给的结局。
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Severity } from '@universe-editor/platform'
import type {
  HeapSnapshotEvent,
  HeapSnapshotNoticeCode,
  HeapSnapshotStatus,
} from '../../../../shared/ipc/services.js'
import {
  describeHeapSnapshotEvent,
  describeHeapSnapshotStatus,
  heapSnapshotNoticeSeverity,
  heapSnapshotNoticeText,
} from '../heapSnapshotMessages.js'

/**
 * main 能发到线上的每一个 code。写成 Record 是为了让新增 `HeapSnapshotNoticeCode` 在这里
 * 直接编译不过——文案表必须跟着长，这正是目的。
 */
const ALL_CODES: Record<HeapSnapshotNoticeCode, true> = {
  'heap-limit-unknown': true,
  'baseline-too-large': true,
  'baseline-unstable': true,
  'sample-stale': true,
  'holders-explain': true,
  'heap-too-large': true,
  'capture-limit-reached': true,
  'physical-memory-low': true,
  'commit-headroom-low': true,
  'commit-unknown': true,
  'disk-space-low': true,
  'disk-unknown': true,
  'directory-budget': true,
  'capture-failed': true,
  'capture-stalled': true,
  'app-quota-exhausted': true,
  'round-quota-exhausted': true,
  'round-expired': true,
  'round-complete': true,
  'window-closed': true,
  'window-reloaded': true,
  'renderer-unavailable': true,
  'stopped-by-user': true,
  'no-target': true,
}

const CODES = Object.keys(ALL_CODES) as HeapSnapshotNoticeCode[]

function event(partial: Partial<HeapSnapshotEvent>): HeapSnapshotEvent {
  return { windowId: 1, revision: 1, at: 1, kind: 'notice', ...partial }
}

const STATUS: HeapSnapshotStatus = {
  active: true,
  phase: 'baseline',
  attempts: 0,
  attemptLimit: 2,
  appAttempts: 0,
  appAttemptLimit: 4,
  artifacts: 0,
  bytes: 0,
}

describe('heapSnapshotNoticeText', () => {
  it('has a sentence for every code main can send', () => {
    for (const code of CODES) {
      expect(heapSnapshotNoticeText(code).trim().length, code).toBeGreaterThan(0)
    }
  })

  it('says what happened rather than naming the code', () => {
    // 用户读的不是枚举；兜底文案若打印 `disk-space-low`，就只有作者看得懂。
    for (const code of CODES) {
      expect(heapSnapshotNoticeText(code), code).not.toContain(code)
    }
  })
})

describe('heapSnapshotNoticeSeverity', () => {
  it('warns about refusals and pressure, and informs about the rest', () => {
    // 抓取被拒不是编辑器出故障，但它是消息：用户要了诊断，却没拿到。
    expect(heapSnapshotNoticeSeverity('disk-space-low')).toBe(Severity.Warning)
    expect(heapSnapshotNoticeSeverity('physical-memory-low')).toBe(Severity.Warning)
    expect(heapSnapshotNoticeSeverity('app-quota-exhausted')).toBe(Severity.Warning)
    expect(heapSnapshotNoticeSeverity('capture-stalled')).toBe(Severity.Warning)

    expect(heapSnapshotNoticeSeverity('round-complete')).toBe(Severity.Info)
    expect(heapSnapshotNoticeSeverity('stopped-by-user')).toBe(Severity.Info)
    expect(heapSnapshotNoticeSeverity('window-reloaded')).toBe(Severity.Info)
  })

  it('never answers with an error, which only a failed capture is', () => {
    for (const code of CODES) {
      expect([Severity.Info, Severity.Warning], code).toContain(heapSnapshotNoticeSeverity(code))
    }
  })
})

describe('describeHeapSnapshotEvent', () => {
  it('spells out the pause when a round starts', () => {
    const toast = describeHeapSnapshotEvent(event({ kind: 'started' }))
    expect(toast.severity).toBe(Severity.Info)
    expect(toast.reveal).toBe(false)
    expect(toast.text).toContain('pause this window')
  })

  it('names the trigger, the file and the size of a written snapshot', () => {
    const toast = describeHeapSnapshotEvent(
      event({
        kind: 'captured',
        artifact: {
          name: '2026-09-18T10-00-00.heapsnapshot',
          bytes: 512 * 1024 * 1024,
          trigger: 'growth',
        },
      }),
    )
    expect(toast.severity).toBe(Severity.Info)
    expect(toast.reveal).toBe(true)
    expect(toast.text).toContain('growth')
    expect(toast.text).toContain('2026-09-18T10-00-00.heapsnapshot')
    expect(toast.text).toContain('512MB')
  })

  it('still says a snapshot was written when the report lost its artifact', () => {
    const toast = describeHeapSnapshotEvent(event({ kind: 'captured' }))
    expect(toast.reveal).toBe(true)
    expect(toast.text).toContain('?')
  })

  it('maps a refusal onto its sentence and drops the raw measurement', () => {
    const toast = describeHeapSnapshotEvent(
      event({ kind: 'notice', code: 'disk-space-low', detail: 'free=120MB' }),
    )
    expect(toast.severity).toBe(Severity.Warning)
    expect(toast.text).toBe(heapSnapshotNoticeText('disk-space-low'))
    expect(toast.text).not.toContain('free=120MB')
  })

  it('keeps the measurements on a failure, which is what a bug report quotes', () => {
    const toast = describeHeapSnapshotEvent(
      event({ kind: 'failed', code: 'capture-failed', detail: '4 seconds' }),
    )
    expect(toast.severity).toBe(Severity.Error)
    expect(toast.text).toContain('4 seconds')
  })

  it('never prints empty parentheses when a failure carried no detail', () => {
    const toast = describeHeapSnapshotEvent(event({ kind: 'failed', code: 'capture-failed' }))
    expect(toast.text).not.toContain('()')
  })

  it('offers the folder once the round is finished or the folder is the problem', () => {
    expect(
      describeHeapSnapshotEvent(event({ kind: 'stopped', code: 'round-complete' })).reveal,
    ).toBe(true)
    expect(
      describeHeapSnapshotEvent(event({ kind: 'stopped', code: 'directory-budget' })).reveal,
    ).toBe(true)
    expect(
      describeHeapSnapshotEvent(event({ kind: 'stopped', code: 'window-reloaded' })).reveal,
    ).toBe(false)
  })

  it('falls back to "stopped by the user" rather than to an empty message', () => {
    const toast = describeHeapSnapshotEvent(event({ kind: 'stopped' }))
    expect(toast.text).toBe(heapSnapshotNoticeText('stopped-by-user'))
  })

  it('does not report a dead renderer as a closed window', () => {
    // 窗口还开着、只是渲染进程崩了：说「窗口已关闭」会把用户指向一个他没做过的事。
    const toast = describeHeapSnapshotEvent(
      event({ kind: 'stopped', code: 'renderer-unavailable' }),
    )
    expect(toast.text).not.toBe(heapSnapshotNoticeText('window-closed'))
    expect(toast.text).toContain('renderer')
    expect(toast.severity).toBe(Severity.Warning)
  })
})

describe('describeHeapSnapshotStatus', () => {
  it('says diagnosis is off when nothing has run', () => {
    const text = describeHeapSnapshotStatus({ ...STATUS, active: false, phase: 'off' })
    // 没什么要解释的：从没要过轮次的窗口没理由显示这条。
    expect(text).toBe('Memory diagnosis is off.')
  })

  it('prints why a round is over, not just that it is', () => {
    const text = describeHeapSnapshotStatus({
      ...STATUS,
      active: false,
      phase: 'stopped',
      code: 'round-expired',
      detail: '2 hours',
    })
    expect(text).toContain(heapSnapshotNoticeText('round-expired'))
    expect(text).toContain('2 hours')
  })

  it('counts attempts and files while a round is running', () => {
    const text = describeHeapSnapshotStatus({ ...STATUS, attempts: 1, artifacts: 1 })
    expect(text).toContain('baseline')
    expect(text).toContain('1/2')
    expect(text).toContain('1')
  })

  it('distinguishes "capturing right now" from "waiting"', () => {
    // 这是窗口冻着时用户读到的那句话；它得解释冻结，而不是报告状态。
    const capturing = describeHeapSnapshotStatus({ ...STATUS, phase: 'capturing' })
    expect(capturing).toContain('pauses the window')
    expect(capturing).not.toBe(describeHeapSnapshotStatus(STATUS))
  })
})
