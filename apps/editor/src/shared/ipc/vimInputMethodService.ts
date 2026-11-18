/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Cross-process contract for switching the OS input method around Vim mode.
 *  Renderer keystrokes cannot suppress IME composition — `preventDefault()` on a
 *  `keyCode === 229` keydown is a no-op, and a readonly textarea does not stop
 *  Chromium from composing either (both were verified against a live IME). Normal
 *  mode therefore has to leave the IME alone: the main process switches the
 *  focused window to English, and Insert mode restores whatever was active.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

export interface IVimInputMethodService {
  readonly _serviceBrand: undefined
  /**
   * Ensure the focused window uses an English input method. Resolves to whether
   * English is active — true when it already was or the switch succeeded, false
   * when the platform is unsupported or the switch failed (callers retry).
   */
  switchToEnglish(): Promise<boolean>
  /** Restore the input method saved by the last {@link switchToEnglish}. */
  restore(): Promise<void>
}

export const IVimInputMethodService =
  createDecorator<IVimInputMethodService>('vimInputMethodService')
