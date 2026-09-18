/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  把 main 发来的稳定快照 id 变成人话。main 从不发散文，只发 code 加数字；每个 code 都在这里
 *  落一条文案——`Record<HeapSnapshotNoticeCode, …>` 让新增 code 直接编译不过，配套测试再让漏译
 *  变成失败：用户刚同意了几秒到几十秒的冻结，一个没有文案的 code 就是一次空白提示。
 *--------------------------------------------------------------------------------------------*/

import { Severity, localize } from '@universe-editor/platform'
import type {
  HeapSnapshotEvent,
  HeapSnapshotNoticeCode,
  HeapSnapshotStatus,
  HeapSnapshotTrigger,
} from '../../../shared/ipc/services.js'

const NOTICE_TEXT: Record<HeapSnapshotNoticeCode, () => string> = {
  'heap-limit-unknown': () =>
    localize(
      'heapSnapshot.notice.heapLimitUnknown',
      'This window never reported a V8 heap limit, so no capture size can be derived. Nothing was captured.',
    ),
  'baseline-too-large': () =>
    localize(
      'heapSnapshot.notice.baselineTooLarge',
      'The heap is already larger than a baseline snapshot may cost. Waiting for it to come down.',
    ),
  'baseline-unstable': () =>
    localize(
      'heapSnapshot.notice.baselineUnstable',
      'The heap is still moving too much for a baseline. Waiting for it to settle.',
    ),
  'sample-stale': () =>
    localize(
      'heapSnapshot.notice.sampleStale',
      'This window stopped reporting memory readings, so the diagnosis has lost its basis.',
    ),
  'holders-explain': () =>
    localize(
      'heapSnapshot.notice.holdersExplain',
      'The rise is already accounted for by the tracked caches; a snapshot would not add a lead.',
    ),
  'heap-too-large': () =>
    localize(
      'heapSnapshot.notice.heapTooLarge',
      'The heap is past the agreed capture ceiling, so no further snapshot is taken automatically.',
    ),
  'capture-limit-reached': () =>
    localize(
      'heapSnapshot.notice.captureLimitReached',
      'There is no headroom left below the capture ceiling, so a growth snapshot could not stay under it.',
    ),
  'physical-memory-low': () =>
    localize(
      'heapSnapshot.notice.physicalMemoryLow',
      'Too little free physical memory right now. This capture was skipped rather than adding pressure.',
    ),
  'commit-headroom-low': () =>
    localize(
      'heapSnapshot.notice.commitHeadroomLow',
      'Too little system commit headroom right now. This capture was skipped rather than adding pressure.',
    ),
  'commit-unknown': () =>
    localize(
      'heapSnapshot.notice.commitUnknown',
      'No fresh commit-memory reading was available, so this capture was skipped rather than guessed at.',
    ),
  'disk-space-low': () =>
    localize(
      'heapSnapshot.notice.diskSpaceLow',
      'Not enough free disk space for a snapshot file. This capture was skipped.',
    ),
  'disk-unknown': () =>
    localize(
      'heapSnapshot.notice.diskUnknown',
      'Free disk space could not be read, so this capture was skipped rather than guessed at.',
    ),
  'directory-budget': () =>
    localize(
      'heapSnapshot.notice.directoryBudget',
      'The snapshot folder reached its limit. Clean it up by hand to start another round.',
    ),
  'capture-failed': () =>
    localize(
      'heapSnapshot.notice.captureFailed',
      'Taking the snapshot failed. The round ends here instead of freezing the window again.',
    ),
  'capture-stalled': () =>
    localize(
      'heapSnapshot.notice.captureStalled',
      'The snapshot is still running past 90 seconds. It cannot be cancelled, so the window may stay paused.',
    ),
  'app-quota-exhausted': () =>
    localize(
      'heapSnapshot.notice.appQuotaExhausted',
      'All snapshots allowed for this app run have been used. Restart the editor to get a new budget.',
    ),
  'round-quota-exhausted': () =>
    localize('heapSnapshot.notice.roundQuotaExhausted', 'This round has used its two captures.'),
  'round-expired': () =>
    localize(
      'heapSnapshot.notice.roundExpired',
      'The 2-hour limit for this diagnosis was reached, so it stopped on its own.',
    ),
  'round-complete': () =>
    localize(
      'heapSnapshot.notice.roundComplete',
      'Both snapshots are on disk: the baseline and the growth one.',
    ),
  'window-closed': () =>
    localize('heapSnapshot.notice.windowClosed', 'The window closed, so this round ended with it.'),
  'window-reloaded': () =>
    localize(
      'heapSnapshot.notice.windowReloaded',
      'The window reloaded, so this round ended: the heap it measured no longer exists.',
    ),
  'renderer-unavailable': () =>
    localize(
      'heapSnapshot.notice.rendererUnavailable',
      "This window's renderer is not running any more, so the round ended. Reload the window to start another one.",
    ),
  'stopped-by-user': () =>
    localize('heapSnapshot.notice.stoppedByUser', 'Memory diagnosis stopped.'),
  'no-target': () =>
    localize(
      'heapSnapshot.notice.noTarget',
      'This window has no live renderer to snapshot, so diagnosis cannot start.',
    ),
}

/** 压力与拒绝算警告；其余是用户自己要看的进展。 */
const NOTICE_WARNING: ReadonlySet<HeapSnapshotNoticeCode> = new Set<HeapSnapshotNoticeCode>([
  'baseline-too-large',
  'sample-stale',
  'heap-too-large',
  'physical-memory-low',
  'commit-headroom-low',
  'commit-unknown',
  'disk-space-low',
  'disk-unknown',
  'directory-budget',
  'capture-stalled',
  'app-quota-exhausted',
  'round-quota-exhausted',
  'round-expired',
  'renderer-unavailable',
])

export function heapSnapshotNoticeText(code: HeapSnapshotNoticeCode): string {
  return NOTICE_TEXT[code]()
}

export function heapSnapshotNoticeSeverity(code: HeapSnapshotNoticeCode): Severity {
  return NOTICE_WARNING.has(code) ? Severity.Warning : Severity.Info
}

function triggerText(trigger: HeapSnapshotTrigger): string {
  return trigger === 'baseline'
    ? localize('heapSnapshot.trigger.baseline', 'baseline')
    : localize('heapSnapshot.trigger.growth', 'growth')
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

export interface HeapSnapshotToast {
  readonly severity: Severity
  readonly text: string
  /** 这条报告是否值得附带「打开快照目录」动作。 */
  readonly reveal: boolean
}

/**
 * 一条轮次报告的人话版本。`detail` 是 main 侧的测量值（个数、秒数、MB），只在排障报告会引用
 * 的结局上追加——过程播报不加，那里它是噪声。
 */
export function describeHeapSnapshotEvent(event: HeapSnapshotEvent): HeapSnapshotToast {
  switch (event.kind) {
    case 'started':
      return {
        severity: Severity.Info,
        text: localize(
          'heapSnapshot.event.started',
          'Memory diagnosis is on: the baseline is being established. Capturing will pause this window for seconds to tens of seconds.',
        ),
        reveal: false,
      }
    case 'captured': {
      const artifact = event.artifact
      const name = artifact?.name ?? '?'
      const size = artifact === undefined ? undefined : megabytes(artifact.bytes)
      return {
        severity: Severity.Info,
        text:
          artifact === undefined
            ? localize('heapSnapshot.event.captured', 'Snapshot written: {name}', { name })
            : localize(
                'heapSnapshot.event.capturedTrigger',
                'The {trigger} snapshot was written: {name} ({size}MB)',
                { trigger: triggerText(artifact.trigger), name, size: String(size) },
              ),
        reveal: true,
      }
    }
    case 'notice': {
      const code = event.code ?? 'stopped-by-user'
      return {
        severity: heapSnapshotNoticeSeverity(code),
        text: withDetail(heapSnapshotNoticeText(code), event.detail, false),
        reveal: code === 'capture-stalled' || code === 'directory-budget',
      }
    }
    case 'failed': {
      const code = event.code ?? 'capture-failed'
      return {
        severity: Severity.Error,
        text: withDetail(heapSnapshotNoticeText(code), event.detail, true),
        reveal: true,
      }
    }
    case 'stopped': {
      const code = event.code ?? 'stopped-by-user'
      return {
        severity: heapSnapshotNoticeSeverity(code),
        text: withDetail(heapSnapshotNoticeText(code), event.detail, false),
        reveal: code === 'directory-budget' || code === 'round-complete',
      }
    }
  }
}

function withDetail(text: string, detail: string | undefined, include: boolean): string {
  return include && detail !== undefined && detail !== '' ? `${text} (${detail})` : text
}

/** 窗口没亲眼看到开局时，能打印出来的状态行。 */
export function describeHeapSnapshotStatus(status: HeapSnapshotStatus): string {
  if (!status.active) {
    if (status.code === undefined) {
      return localize('heapSnapshot.status.off', 'Memory diagnosis is off.')
    }
    const reason = heapSnapshotNoticeText(status.code)
    return `${localize('heapSnapshot.status.ended', 'Memory diagnosis ended:')} ${reason}${
      status.detail === undefined ? '' : ` (${status.detail})`
    }`
  }
  const attempts = `${status.attempts}/${status.attemptLimit}`
  const artifacts = String(status.artifacts)
  if (status.phase === 'capturing') {
    return localize(
      'heapSnapshot.status.capturing',
      'Memory diagnosis: capturing a snapshot right now (this pauses the window). Attempts {attempts}, files {artifacts}.',
      { attempts, artifacts },
    )
  }
  return localize(
    'heapSnapshot.status.running',
    'Memory diagnosis is running ({phase}). Attempts {attempts}, files {artifacts}.',
    {
      phase: status.phase === 'baseline' ? 'baseline' : 'watching',
      attempts,
      artifacts,
    },
  )
}
