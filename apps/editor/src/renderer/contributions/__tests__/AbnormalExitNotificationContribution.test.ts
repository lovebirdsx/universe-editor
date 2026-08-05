/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/AbnormalExitNotificationContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Severity } from '@universe-editor/platform'
import { AbnormalExitNotificationContribution } from '../AbnormalExitNotificationContribution.js'
import type { AbnormalExitInfo, IDiagnosticsService } from '../../../shared/ipc/services.js'

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
      crashDumps: ['D:\\d\\a.dmp', 'D:\\d\\b.dmp'],
    })
    const notifications = makeNotifications()
    const c = new AbnormalExitNotificationContribution(diagnostics, notifications as never)
    await vi.waitFor(() => expect(notifications.notify).toHaveBeenCalledTimes(1))
    const arg = notifications.notify.mock.calls[0]?.[0]
    expect(arg.severity).toBe(Severity.Warning)
    expect(arg.sticky).toBe(true)
    expect(arg.message).toContain('2')
    const reveal = arg.actions.find((a: { label: string }) => a.label.includes('崩溃目录'))
    expect(reveal).toBeDefined()
    reveal.run()
    expect(diagnostics.revealCrashesFolder).toHaveBeenCalledTimes(1)
    c.dispose()
  })

  it('uses the externally-killed wording when no dumps were produced', async () => {
    const diagnostics = makeDiagnostics({
      previousSessionId: 's1',
      previousStartedAt: 1,
      crashDumps: [],
    })
    const notifications = makeNotifications()
    const c = new AbnormalExitNotificationContribution(diagnostics, notifications as never)
    await vi.waitFor(() => expect(notifications.notify).toHaveBeenCalledTimes(1))
    expect(notifications.notify.mock.calls[0]?.[0].message).toContain('外部')
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
