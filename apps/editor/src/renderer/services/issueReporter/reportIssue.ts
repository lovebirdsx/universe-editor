/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Orchestration of the Report Issue flow, extracted from ReportIssueAction so
 *  it can be unit-tested without the Action2/CommandsRegistry machinery. The
 *  flow is provider-agnostic: the configured provider (default iLoop) is asked
 *  for a pre-filled issue URL; providers that support attachments (iLoop)
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
  ILOOP_APP_URL_SETTING_KEY,
  ILOOP_BOARD_SETTING_KEY,
  ILOOP_CATEGORY_SETTING_KEY,
  ILOOP_PROVIDER_ID,
  ILOOP_SERVER_URL_SETTING_KEY,
  ISSUE_REPORTER_PROVIDER_SETTING_KEY,
  ILoopDefaults,
  ILoopOptionKeys,
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
    ...(provider.id === ILOOP_PROVIDER_ID
      ? { providerOptions: collectILoopOptions(deps.configuration) }
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
    const message = err instanceof Error ? err.message : String(err)
    if (!attachDiagnostics) {
      deps.notifications.notify({
        severity: Severity.Error,
        message: localize(
          'reportIssue.failed',
          'Failed to open the issue reporting page: {message}',
          { message },
        ),
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
          },
        },
      ],
    })
  }
}

function collectILoopOptions(config: IConfigurationService): Record<string, string> {
  return {
    [ILoopOptionKeys.serverUrl]:
      config.get<string>(ILOOP_SERVER_URL_SETTING_KEY) ?? ILoopDefaults.serverUrl,
    [ILoopOptionKeys.appUrl]: config.get<string>(ILOOP_APP_URL_SETTING_KEY) ?? ILoopDefaults.appUrl,
    [ILoopOptionKeys.board]: config.get<string>(ILOOP_BOARD_SETTING_KEY) ?? ILoopDefaults.board,
    [ILoopOptionKeys.category]:
      config.get<string>(ILOOP_CATEGORY_SETTING_KEY) ?? ILoopDefaults.category,
  }
}
