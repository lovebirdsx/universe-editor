/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side implementation of the reverse lifecycle contract. The main
 *  process invokes confirmShutdown() before closing a window / quitting; we run
 *  the lifecycle veto chain and report whether the action may proceed.
 *--------------------------------------------------------------------------------------------*/

import {
  type ILifecycleService,
  type ShutdownConfirmationContext,
  type ShutdownReason,
} from '@universe-editor/platform'
import type { IRendererLifecycleService } from '../../../shared/ipc/lifecycleService.js'

export class RendererLifecycleService implements IRendererLifecycleService {
  declare readonly _serviceBrand: undefined

  constructor(private readonly _lifecycle: ILifecycleService) {}

  async confirmShutdown(
    reason: ShutdownReason,
    context?: ShutdownConfirmationContext,
  ): Promise<boolean> {
    const vetoed = await this._lifecycle.confirmBeforeShutdown(reason, context)
    return !vetoed
  }
}
