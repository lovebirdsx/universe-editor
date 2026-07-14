/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reverse IPC contract: implemented in the renderer, invoked from main. The main
 *  process calls this before closing a window / quitting so the renderer can run
 *  its lifecycle veto chain (e.g. confirm before interrupting running sessions).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { ShutdownConfirmationContext, ShutdownReason } from '@universe-editor/platform'

export interface IRendererLifecycleService {
  readonly _serviceBrand: undefined
  /**
   * Ask the renderer whether it is OK to proceed with the given shutdown reason.
   * @returns true if the renderer cleared the action; false if it was vetoed.
   */
  confirmShutdown(reason: ShutdownReason, context?: ShutdownConfirmationContext): Promise<boolean>
}

export const IRendererLifecycleService = createDecorator<IRendererLifecycleService>(
  'rendererLifecycleService',
)
