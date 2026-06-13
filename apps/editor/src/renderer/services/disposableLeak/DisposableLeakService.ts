/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer wrapper around the cross-process IDisposableLeakService.
 *
 *  Adds an in-memory `unloadReason` flag that ReloadWindowAction sets right
 *  before triggering `host.restart()`, so the beforeunload listener can label
 *  the persisted report with its origin. On the next session, a 'reload' source
 *  suppresses the notification (the user already saw the modal).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type {
  DisposableLeakSource,
  IDisposableLeakReport,
  IDisposableLeakService,
} from '../../../shared/ipc/services.js'

export interface IRendererDisposableLeakService {
  readonly _serviceBrand: undefined
  markUnloadReason(source: DisposableLeakSource): void
  readUnloadReason(): DisposableLeakSource
  reportLeaks(report: IDisposableLeakReport): Promise<void>
  printLeaks(report: IDisposableLeakReport): Promise<void>
  consumePendingReport(): Promise<IDisposableLeakReport | null>
}

export const IRendererDisposableLeakService = createDecorator<IRendererDisposableLeakService>(
  'rendererDisposableLeakService',
)

export class RendererDisposableLeakService implements IRendererDisposableLeakService {
  declare readonly _serviceBrand: undefined

  private _unloadReason: DisposableLeakSource = 'unknown'

  constructor(private readonly _proxy: IDisposableLeakService) {}

  markUnloadReason(source: DisposableLeakSource): void {
    this._unloadReason = source
  }

  readUnloadReason(): DisposableLeakSource {
    return this._unloadReason
  }

  reportLeaks(report: IDisposableLeakReport): Promise<void> {
    return this._proxy.reportLeaks(report)
  }

  printLeaks(report: IDisposableLeakReport): Promise<void> {
    return this._proxy.printLeaks(report)
  }

  consumePendingReport(): Promise<IDisposableLeakReport | null> {
    return this._proxy.consumePendingReport()
  }
}
