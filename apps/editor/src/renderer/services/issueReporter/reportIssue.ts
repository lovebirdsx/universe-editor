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
          label: localize('reportIssue.attachDiagnostics', '附带诊断包'),
          description: localize(
            'reportIssue.attachDiagnostics.description',
            '上传诊断 zip 作为附件（含系统信息与近期日志）',
          ),
        },
        { id: 'skip', label: localize('reportIssue.skipDiagnostics', '不附带') },
      ],
      {
        placeholder: localize(
          'reportIssue.attachPrompt',
          '是否在问题报告中附带诊断包？（诊断摘要已复制到剪贴板）',
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
      '（诊断信息较长，请从剪贴板粘贴 / paste the diagnostics summary from your clipboard）',
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
        '诊断摘要已复制到剪贴板，请在打开的上报页面中补充问题描述。',
      ),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!attachDiagnostics) {
      deps.notifications.notify({
        severity: Severity.Error,
        message: localize('reportIssue.failed', '打开问题上报页面失败：{message}', { message }),
      })
      return
    }
    deps.notifications.notify({
      severity: Severity.Error,
      sticky: true,
      message: localize('reportIssue.uploadFailed', '诊断包上传失败：{message}', { message }),
      actions: [
        {
          label: localize('reportIssue.openWithoutAttachment', '不附带诊断包直接打开'),
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
