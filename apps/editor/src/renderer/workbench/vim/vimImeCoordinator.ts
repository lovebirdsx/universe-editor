/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Input-method handoff for the non-editor Vim surfaces. A Normal-mode list, menu,
 *  tab strip or activity bar has no text to compose, but an active Chinese IME
 *  would still swallow the motion keys (`j` becomes a composition). So while such
 *  a surface owns the keyboard in Normal mode the window is switched to English,
 *  and it is given back as soon as focus lands anywhere that types text.
 *
 *  Editors and terminals own their own IME state (`vimEditorController`,
 *  `TerminalNormalModeController`): this coordinator never claims the input
 *  method while one of them is active. All three take and give English through
 *  the owner API of `editor/vim/vimInputMethod.ts`, where only the current holder
 *  can release, so a list -> editor hop neither flips the IME twice nor lets a
 *  stale owner restore Chinese under the new one.
 *
 *  The window matters too: Alt+Tab leaves the focused surface "active" in the
 *  renderer, but English must not follow the user into another application. Focus
 *  is tracked per workbench document (main + auxiliary windows); while none of
 *  them is focused the coordinator releases, and it re-asserts on focus return.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type Event, type IConfigurationService } from '@universe-editor/platform'
import type { IVimInputMethodService } from '../../../shared/ipc/vimInputMethodService.js'
import { releaseInputMethod, requestInputMethod } from '../editor/vim/vimInputMethod.js'
import { VIM_SERVICE_CONFIG_KEYS, type IVimModeService } from '../../services/vim/vimModeService.js'
import {
  getWorkbenchDocuments,
  onDidAddWorkbenchDocument,
  onDidRemoveWorkbenchDocument,
} from '../../services/windows/workbenchDocuments.js'

type Desired = 'english' | 'native' | 'leave'

/** The workbench windows whose focus gates the handoff. */
export interface IVimImeWindowSource {
  getDocuments(): readonly Document[]
  readonly onDidAddDocument: Event<Document>
  readonly onDidRemoveDocument: Event<Document>
}

const workbenchWindows: IVimImeWindowSource = {
  getDocuments: getWorkbenchDocuments,
  onDidAddDocument: onDidAddWorkbenchDocument,
  onDidRemoveDocument: onDidRemoveWorkbenchDocument,
}

export class VimImeCoordinator extends Disposable {
  /** True while this coordinator is the one that switched the window to English. */
  private _holding = false
  private _disposed = false
  /** Focus state per tracked workbench document. */
  private readonly _documents = new Map<Document, { focused: boolean; dispose(): void }>()

  constructor(
    private readonly _vim: Pick<
      IVimModeService,
      | 'getEnabled'
      | 'getMode'
      | 'activeSurface'
      | 'isSurfaceEnabled'
      | 'onDidChangeActiveSurface'
      | 'onDidChangeMode'
    >,
    private readonly _inputMethod: IVimInputMethodService,
    private readonly _config: Pick<IConfigurationService, 'get' | 'onDidChangeConfiguration'>,
    windows: IVimImeWindowSource = workbenchWindows,
  ) {
    super()
    this._register(this._vim.onDidChangeActiveSurface(() => this._sync()))
    this._register(this._vim.onDidChangeMode(() => this._sync()))
    this._register(
      this._config.onDidChangeConfiguration((event) => {
        if (VIM_SERVICE_CONFIG_KEYS.some((key) => event.affectsConfiguration(key))) this._sync()
      }),
    )
    for (const doc of windows.getDocuments()) this._track(doc)
    this._register(windows.onDidAddDocument((doc) => this._track(doc)))
    this._register(windows.onDidRemoveDocument((doc) => this._untrack(doc)))
    this._sync()
  }

  override dispose(): void {
    // Mark first so the listener teardown below cannot re-claim English.
    this._disposed = true
    this._release()
    for (const entry of this._documents.values()) entry.dispose()
    this._documents.clear()
    super.dispose()
  }

  private _track(doc: Document): void {
    if (this._documents.has(doc)) return
    const win = doc.defaultView
    if (win === null) return
    const entry = { focused: doc.hasFocus(), dispose: () => {} }
    const onBlur = (): void => {
      entry.focused = false
      this._sync()
    }
    const onFocus = (): void => {
      entry.focused = true
      this._sync()
    }
    win.addEventListener('blur', onBlur)
    win.addEventListener('focus', onFocus)
    entry.dispose = () => {
      win.removeEventListener('blur', onBlur)
      win.removeEventListener('focus', onFocus)
    }
    this._documents.set(doc, entry)
    this._sync()
  }

  private _untrack(doc: Document): void {
    const entry = this._documents.get(doc)
    if (entry === undefined) return
    this._documents.delete(doc)
    entry.dispose()
    this._sync()
  }

  /** Before any workbench document registers there is nothing to gate on. */
  private _windowFocused(): boolean {
    if (this._documents.size === 0) return true
    for (const entry of this._documents.values()) if (entry.focused) return true
    return false
  }

  private _desired(): Desired {
    if (!this._vim.getEnabled()) return 'native'
    if (this._config.get<boolean>('vim.autoSwitchInputMethod') === false) return 'native'
    if (!this._windowFocused()) return 'native'
    const surface = this._vim.activeSurface
    if (surface === undefined || !this._vim.isSurfaceEnabled(surface.kind)) return 'native'
    const mode = this._vim.getMode(surface.surfaceKey, surface.defaultMode)
    // Editors / terminals decide for themselves while they are in Normal mode.
    if (surface.kind === 'editor') return mode === 'insert' ? 'native' : 'leave'
    if (surface.kind === 'terminal') return mode === 'terminal-normal' ? 'leave' : 'native'
    return mode === 'normal' ? 'english' : 'native'
  }

  private _sync(): void {
    if (this._disposed) return
    const desired = this._desired()
    if (desired === 'leave') return
    if (desired === 'english') {
      this._holding = true
      requestInputMethod(this, this._inputMethod, 'english')
      return
    }
    this._release()
  }

  /**
   * Only give back what this coordinator took; the editor and the terminal
   * release their own, and the guard ignores a release from a non-holder.
   */
  private _release(): void {
    if (!this._holding) return
    this._holding = false
    releaseInputMethod(this, this._inputMethod)
  }
}
