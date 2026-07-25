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
    // Run the full shutdown sequence (veto + will-shutdown joins), not just the
    // veto phase: the window stays alive for the whole round-trip, so join()
    // participants get a reliable moment to clean up (e.g. stopping ACP agent
    // processes) over still-working IPC — unlike beforeunload, whose async
    // sends can be dropped while the page tears down.
    const vetoed = await this._lifecycle.shutdown(reason, context)
    return !vetoed
  }
}
