/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  One call wires a Monaco instance into Vim mode: the controller (state + commands)
 *  and its surface registration (the window-capture stroke routing). FileEditor and
 *  DiffEditor both go through here so the two never differ in how a surface is
 *  declared — only in which editor they hand over and where `surfaceKey` points.
 *--------------------------------------------------------------------------------------------*/

import { registerVimSurface } from '@universe-editor/workbench-ui'
import {
  createVimEditorController,
  type IVimEditorController,
  type IVimEditorControllerOptions,
} from './vimEditorController.js'

export interface VimAttachment {
  readonly controller: IVimEditorController
  /** Unregister the surface first, then the controller (its subscriptions must not outlive the editor). */
  dispose(): void
}

export interface AttachVimOptions extends Omit<
  IVimEditorControllerOptions,
  'surfaceKey' | 'onPendingKeysChange' | 'onUnsupportedKey' | 'onSubModeChange'
> {
  /** Re-read on every use, so one editor reused across tabs follows the active input. */
  readonly surfaceKey: () => string
}

export function attachVim(options: AttachVimOptions): VimAttachment {
  const { vimModeService } = options
  const controller = createVimEditorController({
    ...options,
    onPendingKeysChange: (keys) => vimModeService.setPendingKeys(keys),
    onUnsupportedKey: (key) => vimModeService.reportUnsupportedKey(key),
    onSubModeChange: (mode) => vimModeService.setEditorSubMode(mode),
  })
  const registration = registerVimSurface({
    get id() {
      return options.surfaceKey()
    },
    kind: 'editor',
    getElement: () => options.editor.getContainerDomNode(),
    focus: 'within',
    getSurfaceKey: options.surfaceKey,
    defaultMode: 'normal',
    actions: {
      handleStroke: (event) => controller.handleKeyDown(event),
      isAwaitingCharArg: () => controller.isAwaitingCharArg(),
      takeCount: () => controller.takeCount(),
      getPendingHint: () => controller.getPendingHint(),
    },
  })
  let disposed = false
  return {
    controller,
    dispose() {
      if (disposed) return
      disposed = true
      registration.dispose()
      controller.dispose()
    },
  }
}
