/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/issueReporter/reportIssue.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Severity } from '@universe-editor/platform'
import type {
  IConfigurationService,
  INotificationService,
  IOpenerService,
  IQuickInputService,
  IssueReportPayload,
  IssueReportProviderInfo,
} from '@universe-editor/platform'
import type { IDiagnosticsService, IIssueReporterService } from '../../../../shared/ipc/services.js'
import {
  GITHUB_PROVIDER_ID,
  TRACKER_PROVIDER_ID,
  ISSUE_REPORTER_PROVIDER_SETTING_KEY,
  ISSUE_REPORTER_NOT_CONFIGURED,
  TrackerDefaults,
} from '../../../../shared/issueReporter.js'
import { runReportIssueFlow, type ReportIssueFlowDeps } from '../reportIssue.js'

const GITHUB: IssueReportProviderInfo = {
  id: GITHUB_PROVIDER_ID,
  label: 'GitHub',
  supportsAttachments: false,
}
const TRACKER: IssueReportProviderInfo = {
  id: TRACKER_PROVIDER_ID,
  label: 'Tracker',
  supportsAttachments: true,
}

interface CapturedNotification {
  readonly message: string
  readonly severity: number
  readonly actions?: readonly { label: string; run: () => void }[]
}

function makeDeps(overrides?: {
  providerSetting?: string
  providers?: IssueReportProviderInfo[]
  pickResult?: string | undefined
  buildIssueUrl?: (providerId: string, payload: IssueReportPayload) => Promise<string>
}) {
  const notifications: CapturedNotification[] = []
  const opened: string[] = []
  const buildIssueUrl = vi.fn(
    overrides?.buildIssueUrl ??
      ((_id: string, _p: IssueReportPayload) => Promise.resolve('http://example.com/new')),
  )
  const pick = vi.fn(() =>
    Promise.resolve(
      overrides?.pickResult !== undefined ? { id: overrides.pickResult, label: '' } : undefined,
    ),
  )
  const configGet = (key: string): unknown =>
    key === ISSUE_REPORTER_PROVIDER_SETTING_KEY ? overrides?.providerSetting : undefined

  const deps: ReportIssueFlowDeps = {
    diagnostics: {
      collectIssueReport: () => Promise.resolve('## 版本\n- 应用版本: 1.0.0'),
    } as unknown as IDiagnosticsService,
    issueReporter: {
      listProviders: () => Promise.resolve(overrides?.providers ?? [TRACKER, GITHUB]),
      buildIssueUrl,
    } as unknown as IIssueReporterService,
    notifications: {
      notify: (n: CapturedNotification) => notifications.push(n),
    } as unknown as INotificationService,
    opener: {
      open: (url: string) => {
        opened.push(url)
        return Promise.resolve(true)
      },
    } as unknown as IOpenerService,
    quickInput: { pick } as unknown as IQuickInputService,
    configuration: { get: configGet } as unknown as IConfigurationService,
    writeClipboard: () => Promise.resolve(),
  }
  return { deps, notifications, opened, buildIssueUrl, pick }
}

describe('runReportIssueFlow', () => {
  it('defaults to tracker, asks about the attachment and forwards tracker options', async () => {
    const { deps, opened, buildIssueUrl, pick, notifications } = makeDeps({ pickResult: 'attach' })
    await runReportIssueFlow(deps)

    expect(pick).toHaveBeenCalledTimes(1)
    expect(buildIssueUrl).toHaveBeenCalledWith(
      TRACKER_PROVIDER_ID,
      expect.objectContaining({
        attachDiagnostics: true,
        providerOptions: expect.objectContaining({
          serverUrl: TrackerDefaults.serverUrl,
          appUrl: TrackerDefaults.appUrl,
          board: TrackerDefaults.board,
          category: TrackerDefaults.category,
        }),
      }),
    )
    expect(opened).toEqual(['http://example.com/new'])
    expect(notifications).toHaveLength(1)
  })

  it('cancels silently when the attachment pick is dismissed', async () => {
    const { deps, buildIssueUrl, opened } = makeDeps({ pickResult: undefined })
    await runReportIssueFlow(deps)
    expect(buildIssueUrl).not.toHaveBeenCalled()
    expect(opened).toEqual([])
  })

  it('reports without attachment when the user opts out', async () => {
    const { deps, buildIssueUrl } = makeDeps({ pickResult: 'skip' })
    await runReportIssueFlow(deps)
    expect(buildIssueUrl).toHaveBeenCalledWith(
      TRACKER_PROVIDER_ID,
      expect.objectContaining({ attachDiagnostics: false }),
    )
  })

  it('skips the attachment prompt for GitHub and sends no providerOptions', async () => {
    const { deps, pick, buildIssueUrl } = makeDeps({ providerSetting: GITHUB_PROVIDER_ID })
    await runReportIssueFlow(deps)
    expect(pick).not.toHaveBeenCalled()
    const payload = buildIssueUrl.mock.calls[0]?.[1] as IssueReportPayload
    expect(buildIssueUrl.mock.calls[0]?.[0]).toBe(GITHUB_PROVIDER_ID)
    expect(payload.attachDiagnostics).toBe(false)
    expect(payload.providerOptions).toBeUndefined()
  })

  it('falls back to the first provider when the configured one is unknown', async () => {
    const { deps, buildIssueUrl } = makeDeps({ providerSetting: 'nope', pickResult: 'skip' })
    await runReportIssueFlow(deps)
    expect(buildIssueUrl.mock.calls[0]?.[0]).toBe(TRACKER_PROVIDER_ID)
  })

  it('warns when no provider is registered', async () => {
    const { deps, notifications, buildIssueUrl } = makeDeps({ providers: [] })
    await runReportIssueFlow(deps)
    expect(buildIssueUrl).not.toHaveBeenCalled()
    expect(notifications).toHaveLength(1)
  })

  it('offers an attach-free fallback when the upload fails', async () => {
    const { deps, notifications, buildIssueUrl } = makeDeps({
      pickResult: 'attach',
      buildIssueUrl: (_id, payload) =>
        payload.attachDiagnostics
          ? Promise.reject(new Error('Diagnostics upload failed: HTTP 500'))
          : Promise.resolve('http://example.com/no-attach'),
    })
    await runReportIssueFlow(deps)

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.severity).toBe(Severity.Error)
    expect(notifications[0]?.message).toContain('Failed to upload the diagnostics bundle')
    expect(notifications[0]?.message).not.toContain(ISSUE_REPORTER_NOT_CONFIGURED)
    const fallback = notifications[0]?.actions?.[0]
    expect(fallback).toBeDefined()
    expect(fallback?.label).toContain('Open without attachment')
    fallback!.run()
    await vi.waitFor(() => {
      expect(buildIssueUrl).toHaveBeenLastCalledWith(
        TRACKER_PROVIDER_ID,
        expect.objectContaining({ attachDiagnostics: false }),
      )
    })
  })

  it('shows a plain not-configured error without the fallback action', async () => {
    const { deps, notifications } = makeDeps({
      pickResult: 'attach',
      buildIssueUrl: () =>
        Promise.reject(
          new Error(
            ISSUE_REPORTER_NOT_CONFIGURED +
              'Issue tracker is not configured. Set issueReporter.tracker.serverUrl and issueReporter.tracker.appUrl.',
          ),
        ),
    })
    await runReportIssueFlow(deps)

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.severity).toBe(Severity.Error)
    expect(notifications[0]?.actions).toBeUndefined()
    expect(notifications[0]?.message).not.toContain(ISSUE_REPORTER_NOT_CONFIGURED)
    expect(notifications[0]?.message).toContain('not configured')
  })

  it('notifies again when the attach-free fallback also fails', async () => {
    const { deps, notifications } = makeDeps({
      pickResult: 'attach',
      buildIssueUrl: () => Promise.reject(new Error('boom')),
    })
    await runReportIssueFlow(deps)

    expect(notifications).toHaveLength(1)
    const fallback = notifications[0]?.actions?.[0]
    expect(fallback).toBeDefined()
    fallback!.run()
    await vi.waitFor(() => {
      expect(notifications).toHaveLength(2)
    })
    expect(notifications[1]?.message).toContain('boom')
    expect(notifications[1]?.actions).toBeUndefined()
  })

  it('surfaces plain errors without a fallback when nothing was attached', async () => {
    const { deps, notifications } = makeDeps({
      pickResult: 'skip',
      buildIssueUrl: () => Promise.reject(new Error('boom')),
    })
    await runReportIssueFlow(deps)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.actions).toBeUndefined()
    expect(notifications[0]?.message).toContain('boom')
  })
})
