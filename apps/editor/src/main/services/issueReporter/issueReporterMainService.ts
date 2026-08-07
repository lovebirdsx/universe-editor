/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Issue reporter facade (main side): holds the IssueReporterRegistry with the
 *  built-in providers (GitHub / iLoop) and dispatches buildIssueUrl calls from
 *  the renderer. The iLoop provider needs the diagnostics zip, which is why the
 *  zip factory is injected by the singleton registration rather than pulled via
 *  DI (keeps the provider itself DI-free and unit-testable).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type ILogger,
  ILoggerService,
  IssueReporterRegistry,
  createNamedLogger,
  localize,
  type IssueReportPayload,
  type IssueReportProviderInfo,
} from '@universe-editor/platform'
import type { IIssueReporterService } from '../../../shared/ipc/services.js'
import { GitHubIssueReporterProvider } from './providers/githubProvider.js'
import { ILoopIssueReporterProvider } from './providers/iloopProvider.js'

export interface IssueReporterMainServiceOptions {
  readonly createDiagnosticsZip: () => Promise<string>
}

export class IssueReporterMainService extends Disposable implements IIssueReporterService {
  declare readonly _serviceBrand: undefined

  private readonly _registry = this._register(new IssueReporterRegistry())

  constructor(
    options: IssueReporterMainServiceOptions,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    const logger: ILogger = createNamedLogger(loggerService, {
      id: 'issueReporter',
      name: 'Issue Reporter',
    })
    this._register(this._registry.registerProvider(new GitHubIssueReporterProvider()))
    this._register(
      this._registry.registerProvider(
        new ILoopIssueReporterProvider(options.createDiagnosticsZip, logger),
      ),
    )
  }

  listProviders(): Promise<IssueReportProviderInfo[]> {
    return Promise.resolve(this._registry.listProviders())
  }

  async buildIssueUrl(providerId: string, payload: IssueReportPayload): Promise<string> {
    const provider = this._registry.getProvider(providerId)
    if (!provider) {
      throw new Error(
        localize(
          'issueReporter.error.unknownProvider',
          "Unknown issue reporter provider '{providerId}'",
          { providerId },
        ),
      )
    }
    if (payload.attachDiagnostics && !provider.supportsAttachments) {
      throw new Error(
        localize(
          'issueReporter.error.attachmentsNotSupported',
          "Issue reporter provider '{providerId}' does not support attachments",
          { providerId },
        ),
      )
    }
    return provider.buildIssueUrl(payload)
  }
}
