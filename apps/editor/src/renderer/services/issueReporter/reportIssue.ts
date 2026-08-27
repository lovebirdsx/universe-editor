/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Orchestration of the Report Issue flow, extracted from ReportIssueAction so
 *  it can be unit-tested without the Action2/CommandsRegistry machinery. The
 *  flow is provider-agnostic: the configured provider (default tracker) is asked
 *  for a pre-filled issue URL; providers that support attachments (tracker)
 *  first prompt whether to upload the diagnostics zip.
 *--------------------------------------------------------------------------------------------*/

import {
  Severity,
  localize,
  type IConfigurationService,
  type INotificationService,
  type IOpenerService,
  type IQuickInputService,
  type IssueReportPayload,
} from '@universe-editor/platform'
import type { IDiagnosticsService, IIssueReporterService } from '../../../shared/ipc/services.js'
import {
  DEFAULT_ISSUE_REPORTER_PROVIDER,
  TRACKER_APP_URL_SETTING_KEY,
  TRACKER_BOARD_SETTING_KEY,
  TRACKER_CATEGORY_SETTING_KEY,
  TRACKER_PROVIDER_ID,
  TRACKER_SERVER_URL_SETTING_KEY,
  ISSUE_REPORTER_PROVIDER_SETTING_KEY,
  ISSUE_REPORTER_NOT_CONFIGURED,
  TrackerDefaults,
  TrackerOptionKeys,
} from '../../../shared/issueReporter.js'

/** All services must be captured synchronously before the first await (async accessors go stale). */
export interface ReportIssueFlowDeps {
  readonly diagnostics: IDiagnosticsService
  readonly issueReporter: IIssueReporterService
  readonly notifications: INotificationService
  readonly opener: IOpenerService
  readonly quickInput: IQuickInputService
  readonly configuration: IConfigurationService
  /** Injectable for tests: navigator.clipboard.writeText in the real action. */
  readonly writeClipboard: (text: string) => Promise<void>
}

export async function runReportIssueFlow(deps: ReportIssueFlowDeps): Promise<void> {
  const providers = await deps.issueReporter.listProviders()
  const preferred =
    deps.configuration.get<string>(ISSUE_REPORTER_PROVIDER_SETTING_KEY) ??
    DEFAULT_ISSUE_REPORTER_PROVIDER
  const provider = providers.find((p) => p.id === preferred) ?? providers[0]
  if (!provider) {
    deps.notifications.notify({
      severity: Severity.Warning,
      message: localize('reportIssue.noProvider', 'No issue reporting target is available.'),
    })
    return
  }

  const markdown = await deps.diagnostics.collectIssueReport()
  await deps.writeClipboard(markdown)

  let attachDiagnostics = false
  if (provider.supportsAttachments) {
    const picked = await deps.quickInput.pick(
      [
        {
          id: 'attach',
          label: localize('reportIssue.attachDiagnostics', 'Attach diagnostics bundle'),
          description: localize(
            'reportIssue.attachDiagnostics.description',
            'Upload the diagnostics zip as an attachment (includes system info and recent logs)',
          ),
        },
        { id: 'skip', label: localize('reportIssue.skipDiagnostics', 'Do not attach') },
      ],
      {
        placeholder: localize(
          'reportIssue.attachPrompt',
          'Attach a diagnostics bundle to the issue report? (The diagnostics summary has been copied to your clipboard)',
        ),
      },
    )
    if (!picked) return
    attachDiagnostics = picked.id === 'attach'
  }

  const payload: IssueReportPayload = {
    markdown,
    pasteHint: localize(
      'reportIssue.pasteHint',
      '(The diagnostics summary is long — please paste it from your clipboard)',
    ),
    attachDiagnostics,
    ...(provider.id === TRACKER_PROVIDER_ID
      ? { providerOptions: collectTrackerOptions(deps.configuration) }
      : {}),
  }

  try {
    const url = await deps.issueReporter.buildIssueUrl(provider.id, payload)
    await deps.opener.open(url)
    deps.notifications.notify({
      severity: Severity.Info,
      message: localize(
        'reportIssue.opened',
        'The diagnostics summary has been copied to your clipboard. Please describe the issue on the reporting page that just opened.',
      ),
    })
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const notConfigured = raw.startsWith(ISSUE_REPORTER_NOT_CONFIGURED)
    const message = notConfigured ? raw.slice(ISSUE_REPORTER_NOT_CONFIGURED.length) : raw
    // Not configured: retrying without the attachment fails the same way, so skip
    // the "upload failed" wording and the pointless fallback action.
    if (!attachDiagnostics || notConfigured) {
      deps.notifications.notify({
        severity: Severity.Error,
        message: notConfigured
          ? message
          : localize('reportIssue.failed', 'Failed to open the issue reporting page: {message}', {
              message,
            }),
      })
      return
    }
    deps.notifications.notify({
      severity: Severity.Error,
      sticky: true,
      message: localize(
        'reportIssue.uploadFailed',
        'Failed to upload the diagnostics bundle: {message}',
        { message },
      ),
      actions: [
        {
          label: localize('reportIssue.openWithoutAttachment', 'Open without attachment'),
          run: () => {
            void deps.issueReporter
              .buildIssueUrl(provider.id, { ...payload, attachDiagnostics: false })
              .then((url) => deps.opener.open(url))
              .catch((fallbackErr: unknown) => {
                const detail =
                  fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
                deps.notifications.notify({
                  severity: Severity.Error,
                  message: localize(
                    'reportIssue.failed',
                    'Failed to open the issue reporting page: {message}',
                    { message: detail.replace(ISSUE_REPORTER_NOT_CONFIGURED, '') },
                  ),
                })
              })
          },
        },
      ],
    })
  }
}

function collectTrackerOptions(config: IConfigurationService): Record<string, string> {
  return {
    [TrackerOptionKeys.serverUrl]:
      config.get<string>(TRACKER_SERVER_URL_SETTING_KEY) ?? TrackerDefaults.serverUrl,
    [TrackerOptionKeys.appUrl]:
      config.get<string>(TRACKER_APP_URL_SETTING_KEY) ?? TrackerDefaults.appUrl,
    [TrackerOptionKeys.board]:
      config.get<string>(TRACKER_BOARD_SETTING_KEY) ?? TrackerDefaults.board,
    [TrackerOptionKeys.category]:
      config.get<string>(TRACKER_CATEGORY_SETTING_KEY) ?? TrackerDefaults.category,
  }
}
