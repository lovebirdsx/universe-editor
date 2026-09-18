/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/HeapSnapshotNotificationContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Emitter, Severity } from '@universe-editor/platform'
import { HeapSnapshotNotificationContribution } from '../HeapSnapshotNotificationContribution.js'
import type {
  HeapSnapshotEvent,
  HeapSnapshotStatus,
  IDiagnosticsService,
} from '../../../shared/ipc/services.js'

const OFF_STATUS: HeapSnapshotStatus = {
  active: false,
  phase: 'off',
  attempts: 0,
  attemptLimit: 2,
  appAttempts: 0,
  appAttemptLimit: 4,
  artifacts: 0,
  bytes: 0,
}

interface Harness {
  readonly contribution: HeapSnapshotNotificationContribution
  readonly notices: Array<{
    severity: Severity
    message: string
    sticky?: boolean
    actions?: Array<{ label: string; run: () => void }>
  }>
  readonly revealHeapSnapshotsFolder: ReturnType<typeof vi.fn>
  emit(event: Partial<HeapSnapshotEvent>): void
  dispose(): void
}

function harness(reveal: () => Promise<void> = () => Promise.resolve()): Harness {
  const emitter = new Emitter<HeapSnapshotEvent>()
  const notices: Harness['notices'] = []
  const revealHeapSnapshotsFolder = vi.fn(reveal)
  const diagnostics: IDiagnosticsService = {
    _serviceBrand: undefined,
    consumeAbnormalExitReport: () => Promise.resolve(null),
    revealCrashesFolder: () => Promise.resolve(),
    collectIssueReport: () => Promise.resolve(''),
    exportDiagnosticsZip: () => Promise.resolve(''),
    createDiagnosticsZip: () => Promise.resolve(''),
    reportRendererHeapSample: () => Promise.resolve(),
    startHeapSnapshotRound: () => Promise.resolve(OFF_STATUS),
    stopHeapSnapshotRound: () => Promise.resolve(OFF_STATUS),
    getHeapSnapshotStatus: () => Promise.resolve(OFF_STATUS),
    revealHeapSnapshotsFolder,
    onDidChangeHeapSnapshot: emitter.event,
  }
  const notifications = {
    notify: (options: Harness['notices'][number]) => {
      notices.push(options)
      return { close: () => {} }
    },
  }
  const contribution = new HeapSnapshotNotificationContribution(diagnostics, notifications as never)
  return {
    contribution,
    notices,
    revealHeapSnapshotsFolder,
    emit: (event) => emitter.fire({ windowId: 1, revision: 1, at: 1, kind: 'notice', ...event }),
    dispose: () => emitter.dispose(),
  }
}

describe('HeapSnapshotNotificationContribution', () => {
  const harnesses: Harness[] = []

  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.dispose()
  })

  function make(reveal?: () => Promise<void>): Harness {
    const created = harness(reveal)
    harnesses.push(created)
    return created
  }

  it('drops a report that is not newer than the one already shown', () => {
    // 窗口 reload 期间结束的轮次仍可能迟到一条报告；重放它等于用一条并不在跑的诊断去盖住
    // 正在跑的那条。
    const h = make()
    h.emit({ revision: 4, kind: 'started' })
    h.emit({ revision: 4, kind: 'started' })
    h.emit({ revision: 3, kind: 'failed', code: 'capture-failed' })
    expect(h.notices).toHaveLength(1)
  })

  it('shows the next round even though its revisions restart higher', () => {
    const h = make()
    h.emit({ revision: 1, kind: 'stopped', code: 'stopped-by-user' })
    h.emit({ revision: 2, kind: 'started' })
    expect(h.notices.map((n) => n.message)).toHaveLength(2)
  })

  it('lets the running commentary scroll away and holds onto outcomes', () => {
    // 用户没要过的冻结，它的提示不能自己消失。
    const h = make()
    h.emit({ revision: 1, kind: 'started' })
    h.emit({ revision: 2, kind: 'notice', code: 'holders-explain' })
    h.emit({
      revision: 3,
      kind: 'captured',
      artifact: { name: 'a.heapsnapshot', bytes: 1, trigger: 'baseline' },
    })
    h.emit({ revision: 4, kind: 'failed', code: 'capture-failed' })
    h.emit({ revision: 5, kind: 'stopped', code: 'round-complete' })
    expect(h.notices.map((n) => n.sticky)).toEqual([false, false, true, true, true])
  })

  it('offers the folder only where opening it helps', () => {
    const h = make()
    h.emit({ revision: 1, kind: 'started' })
    h.emit({ revision: 2, kind: 'stopped', code: 'round-complete' })
    expect(h.notices[0]?.actions).toBeUndefined()
    expect(h.notices[1]?.actions).toHaveLength(1)
  })

  it('opens the folder through main, which owns the path', async () => {
    const h = make()
    h.emit({
      revision: 1,
      kind: 'captured',
      artifact: { name: 'a.heapsnapshot', bytes: 1, trigger: 'baseline' },
    })
    h.notices[0]?.actions?.[0]?.run()
    await vi.waitFor(() => expect(h.revealHeapSnapshotsFolder).toHaveBeenCalledTimes(1))
    expect(h.notices).toHaveLength(1)
  })

  it('reports a folder it could not open instead of swallowing it', async () => {
    const h = make(() => Promise.reject(new Error('no shell handler')))
    h.emit({
      revision: 1,
      kind: 'captured',
      artifact: { name: 'a.heapsnapshot', bytes: 1, trigger: 'baseline' },
    })
    h.notices[0]?.actions?.[0]?.run()
    await vi.waitFor(() => expect(h.notices).toHaveLength(2))
    expect(h.notices[1]?.severity).toBe(Severity.Error)
    expect(h.notices[1]?.message).toContain('no shell handler')
  })

  it('stops listening when it is disposed', () => {
    const h = make()
    h.dispose()
    h.emit({ revision: 1, kind: 'started' })
    expect(h.notices).toEqual([])
  })
})
