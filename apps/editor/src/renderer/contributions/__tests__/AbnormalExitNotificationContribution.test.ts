/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/AbnormalExitNotificationContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Event, Severity } from '@universe-editor/platform'
import { AbnormalExitNotificationContribution } from '../AbnormalExitNotificationContribution.js'
import type {
  AbnormalExitInfo,
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

function makeDiagnostics(report: AbnormalExitInfo | null): IDiagnosticsService & {
  revealCrashesFolder: ReturnType<typeof vi.fn>
} {
  const revealCrashesFolder = vi.fn().mockResolvedValue(undefined)
  return {
    _serviceBrand: undefined,
    consumeAbnormalExitReport: () => Promise.resolve(report),
    revealCrashesFolder,
    collectIssueReport: () => Promise.resolve(''),
    exportDiagnosticsZip: () => Promise.resolve(''),
    createDiagnosticsZip: () => Promise.resolve(''),
    reportRendererHeapSample: () => Promise.resolve(),
    startHeapSnapshotRound: () => Promise.resolve(OFF_STATUS),
    stopHeapSnapshotRound: () => Promise.resolve(OFF_STATUS),
    getHeapSnapshotStatus: () => Promise.resolve(OFF_STATUS),
    revealHeapSnapshotsFolder: () => Promise.resolve(),
    onDidChangeHeapSnapshot: Event.None,
  }
}

function makeNotifications() {
  const notify = vi.fn()
  return { notify }
}

describe('AbnormalExitNotificationContribution', () => {
  it('notifies with dump count and a reveal action when dumps exist', async () => {
    const diagnostics = makeDiagnostics({
      previousSessionId: 's1',
      previousStartedAt: 1,
      previousLastAliveAt: 1,
      crashDumps: ['D:\\d\\a.dmp', 'D:\\d\\b.dmp'],
    })
    const notifications = makeNotifications()
    const c = new AbnormalExitNotificationContribution(diagnostics, notifications as never)
    await vi.waitFor(() => expect(notifications.notify).toHaveBeenCalledTimes(1))
    const arg = notifications.notify.mock.calls[0]?.[0]
    expect(arg.severity).toBe(Severity.Warning)
    expect(arg.sticky).toBe(true)
    expect(arg.message).toContain('2')
    const reveal = arg.actions.find((a: { label: string }) => a.label.includes('Crashes'))
    expect(reveal).toBeDefined()
    reveal.run()
    expect(diagnostics.revealCrashesFolder).toHaveBeenCalledTimes(1)
    c.dispose()
  })

  it('stays neutral when no dumps were produced', async () => {
    const diagnostics = makeDiagnostics({
      previousSessionId: 's1',
      previousStartedAt: 1,
      previousLastAliveAt: Date.UTC(2026, 7, 6, 12, 37, 59),
      crashDumps: [],
    })
    const notifications = makeNotifications()
    const c = new AbnormalExitNotificationContribution(diagnostics, notifications as never)
    await vi.waitFor(() => expect(notifications.notify).toHaveBeenCalledTimes(1))
    const message = notifications.notify.mock.calls[0]?.[0].message
    // 只知道「没留 dump」：不猜死因，也不提没查过的事件日志
    expect(message).toContain('unknown')
    expect(message).not.toContain('externally')
    expect(message).not.toContain('antivirus')
    expect(message).not.toContain('memory')
    expect(message).toContain(new Date(Date.UTC(2026, 7, 6, 12, 37, 59)).toLocaleString())
    c.dispose()
  })

  it('stays silent when the previous session exited cleanly', async () => {
    const diagnostics = makeDiagnostics(null)
    const notifications = makeNotifications()
    const c = new AbnormalExitNotificationContribution(diagnostics, notifications as never)
    await new Promise((r) => setTimeout(r, 10))
    expect(notifications.notify).not.toHaveBeenCalled()
    c.dispose()
  })
})
