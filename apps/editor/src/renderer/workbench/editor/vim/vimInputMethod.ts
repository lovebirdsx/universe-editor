/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Window-wide input-method ownership for Vim mode. Renderer keystrokes cannot
 *  suppress IME composition, so Normal mode leaves the input method instead: main
 *  switches the focused window to English there and Insert mode restores it.
 *
 *  Main keeps one saved input method per window (`VimInputMethodMainService.saved`),
 *  so ownership is tracked at the same granularity here — a per-controller copy
 *  would let a newly mounted editor group restore Chinese under the focused
 *  group's feet. Every caller identifies itself with an `owner` token: only the
 *  current holder of English can hand it back, so a background editor reacting to
 *  a config change cannot cancel the focused surface's English.
 *--------------------------------------------------------------------------------------------*/

import type { IVimInputMethodService } from '../../../../shared/ipc/vimInputMethodService.js'

export type VimInputMethodTarget = 'english' | 'native'

/** Identity of a surface asking for the input method (the controller / coordinator instance). */
export type VimInputMethodOwner = object

let inputMethodState: VimInputMethodTarget | null = null
let englishOwner: VimInputMethodOwner | null = null
let inputMethodChain: Promise<void> = Promise.resolve()

/**
 * Ask main for `desired` on behalf of `owner`. `english` takes the window-wide
 * ownership (a surface gaining focus replaces the previous holder); `native` is
 * honored only when `owner` holds English or nobody does, so a surface that never
 * switched cannot undo someone else's switch. Only transitions reach main — this
 * runs on every keystroke, and the guard collapses the no-ops. Calls are
 * serialized so a fast Esc → i pair cannot reorder the two IPC calls.
 */
export function requestInputMethod(
  owner: VimInputMethodOwner,
  service: IVimInputMethodService,
  desired: VimInputMethodTarget,
): void {
  if (desired === 'english') {
    englishOwner = owner
  } else {
    if (englishOwner !== null && englishOwner !== owner) return
    englishOwner = null
  }
  if (desired === inputMethodState) return
  inputMethodState = desired
  inputMethodChain = inputMethodChain
    .then(async () => {
      if (desired === 'native') {
        await service.restore()
        return
      }
      // `switchToEnglish` reports whether English is active, not whether it
      // switched, so an already-English IME stays deduped; a refusal (null
      // HWND, no IME context) falls back to `native` and retries next stroke.
      if (!(await service.switchToEnglish()) && inputMethodState === 'english') {
        inputMethodState = 'native'
        if (englishOwner === owner) englishOwner = null
      }
    })
    .catch((error: unknown) => {
      console.debug('[vim] input method switch failed; assuming native', error)
      inputMethodState = 'native'
      if (englishOwner === owner) englishOwner = null
    })
}

/**
 * Give English back when `owner` goes away or loses focus. A no-op unless `owner`
 * is the one holding English, so a background group's disposal never yanks
 * Chinese back under the focused group.
 */
export function releaseInputMethod(
  owner: VimInputMethodOwner,
  service: IVimInputMethodService,
): void {
  if (englishOwner !== owner) return
  requestInputMethod(owner, service, 'native')
}

/** Window-level state is module-global; tests settle it between cases. */
export function resetVimInputMethodForTests(): void {
  inputMethodState = null
  englishOwner = null
  inputMethodChain = Promise.resolve()
}
