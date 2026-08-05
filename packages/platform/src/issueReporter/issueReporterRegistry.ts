/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure id → provider registry for the Report Issue flow, held by the main
 *  process. No IPC / Electron dependency, so it can be unit-tested in plain
 *  node (same shape as AiModelRegistry).
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IDisposable, toDisposable } from '../base/lifecycle.js'
import type { IIssueReporterProvider, IssueReportProviderInfo } from './issueReporterProvider.js'

export class IssueReporterRegistry extends Disposable {
  private readonly _providers = new Map<string, IIssueReporterProvider>()

  registerProvider(provider: IIssueReporterProvider): IDisposable {
    if (this._providers.has(provider.id)) {
      throw new Error(`Issue reporter provider '${provider.id}' is already registered`)
    }
    this._providers.set(provider.id, provider)
    return toDisposable(() => {
      if (this._providers.get(provider.id) !== provider) return
      this._providers.delete(provider.id)
    })
  }

  getProvider(id: string): IIssueReporterProvider | undefined {
    return this._providers.get(id)
  }

  listProviders(): IssueReportProviderInfo[] {
    return [...this._providers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      supportsAttachments: p.supportsAttachments,
    }))
  }

  override dispose(): void {
    this._providers.clear()
    super.dispose()
  }
}
