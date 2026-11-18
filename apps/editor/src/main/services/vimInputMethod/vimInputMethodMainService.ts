/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Win32 input-method switching for Vim mode. Kept in the main process because
 *  the renderer cannot suppress IME composition from JavaScript — by the time a
 *  Normal-mode keydown arrives as `keyCode === 229` the IME already owns it.
 *
 *  Two mechanisms, tried in order:
 *  - Keyboard layout: `LoadKeyboardLayoutW` + `WM_INPUTLANGCHANGEREQUEST` (what
 *    im-select does). Works when en-US is installed beside the Chinese layout.
 *  - IME conversion mode: `ImmSetConversionStatus` on the focused window's input
 *    context, i.e. the Shift in/out of a TSF IME such as Microsoft Pinyin. Used
 *    when the en-US layout cannot be loaded.
 *
 *  Non-Windows platforms are a silent no-op. Every failure path is logged, not
 *  thrown: Vim mode must keep working when the OS refuses to switch.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger } from '@universe-editor/platform'
import type { IVimInputMethodService } from '../../../shared/ipc/vimInputMethodService.js'

const IME_CMODE_NATIVE = 0x0001
// 0 = load the layout without activating it on the calling (main) thread; the
// activation itself is the WM_INPUTLANGCHANGEREQUEST below, targeted at the
// foreground window. KLF_ACTIVATE would also flip every other window's IME.
const KLF_LOAD_ONLY = 0
const WM_INPUTLANGCHANGEREQUEST = 0x0050
const EN_US_KLID = '00000409'

export interface Win32Imports {
  GetForegroundWindow(): number
  GetWindowThreadProcessId(hwnd: number, processId: [number | null]): number
  GetCurrentThreadId(): number
  GetKeyboardLayout(threadId: number): number
  LoadKeyboardLayoutW(klid: string, flags: number): number
  PostMessageW(hwnd: number, message: number, wParam: number, lParam: number): number
  AttachThreadInput(attach: number, attachTo: number, attachFlag: number): number
  ImmGetContext(hwnd: number): number
  ImmGetConversionStatus(
    himc: number,
    conversion: [number | null],
    sentence: [number | null],
  ): number
  ImmSetConversionStatus(himc: number, conversion: number, sentence: number): number
  ImmReleaseContext(hwnd: number, himc: number): number
}

type SavedInputMethod =
  | { readonly kind: 'layout'; readonly hwnd: number; readonly hkl: number }
  | { readonly kind: 'conversion'; readonly hwnd: number }

let win32Promise: Promise<Win32Imports | null> | null = null

function loadWin32(logger: ILogger): Promise<Win32Imports | null> {
  win32Promise ??= (async () => {
    if (process.platform !== 'win32') return null
    try {
      // Lazy: koffi is a native module, and non-Windows builds should never
      // touch it just to have Vim mode available.
      const koffi = (await import('koffi')).default
      const user32 = koffi.load('user32.dll')
      const imm32 = koffi.load('imm32.dll')
      const kernel32 = koffi.load('kernel32.dll')
      return {
        GetForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
        GetWindowThreadProcessId: user32.func(
          'uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32_t *lpdwProcessId)',
        ),
        GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
        GetKeyboardLayout: user32.func('uintptr_t __stdcall GetKeyboardLayout(uint32_t idThread)'),
        LoadKeyboardLayoutW: user32.func(
          'uintptr_t __stdcall LoadKeyboardLayoutW(const char16_t *pwszKLID, uint32_t Flags)',
        ),
        PostMessageW: user32.func(
          'int __stdcall PostMessageW(uintptr_t hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)',
        ),
        AttachThreadInput: user32.func(
          'int __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, int fAttach)',
        ),
        ImmGetContext: imm32.func('uintptr_t __stdcall ImmGetContext(uintptr_t hwnd)'),
        ImmGetConversionStatus: imm32.func(
          'int __stdcall ImmGetConversionStatus(uintptr_t himc, _Out_ uint32_t *conversion, _Out_ uint32_t *sentence)',
        ),
        ImmSetConversionStatus: imm32.func(
          'int __stdcall ImmSetConversionStatus(uintptr_t himc, uint32_t conversion, uint32_t sentence)',
        ),
        ImmReleaseContext: imm32.func(
          'int __stdcall ImmReleaseContext(uintptr_t hwnd, uintptr_t himc)',
        ),
      } as unknown as Win32Imports
    } catch (error) {
      logger.warn('[vim] input method support unavailable', error)
      return null
    }
  })()
  return win32Promise
}

export class VimInputMethodMainService implements IVimInputMethodService {
  readonly _serviceBrand: undefined
  private saved: SavedInputMethod | null = null
  private readonly loadApi: () => Promise<Win32Imports | null>

  constructor(
    private readonly logger: ILogger,
    loadApi?: () => Promise<Win32Imports | null>,
  ) {
    this.loadApi = loadApi ?? (() => loadWin32(this.logger))
  }

  async switchToEnglish(): Promise<boolean> {
    // Already switched by this window: English is (still) active.
    if (this.saved !== null) return true
    const api = await this.loadApi()
    if (api === null) return false
    try {
      const hwnd = api.GetForegroundWindow()
      if (hwnd === 0) return false
      const threadId = api.GetWindowThreadProcessId(hwnd, [null])
      if (threadId === 0) return false

      const currentHkl = api.GetKeyboardLayout(threadId)
      const englishHkl = api.LoadKeyboardLayoutW(EN_US_KLID, KLF_LOAD_ONLY)
      if (englishHkl !== 0) {
        if (currentHkl === englishHkl) return true
        if (api.PostMessageW(hwnd, WM_INPUTLANGCHANGEREQUEST, 0, englishHkl) === 0) {
          this.logger.warn(`[vim] failed to request input-language change for hwnd ${hwnd}`)
          return false
        }
        this.saved = { kind: 'layout', hwnd, hkl: currentHkl }
        return true
      }

      // No en-US layout installed: flip the IME's own Chinese/English mode.
      if (!this.setConversionMode(api, hwnd, false)) {
        this.logger.warn('[vim] could not switch the IME to English (no en-US layout)')
        return false
      }
      this.saved = { kind: 'conversion', hwnd }
      return true
    } catch (error) {
      this.logger.warn('[vim] failed to switch input method to English', error)
      return false
    }
  }

  async restore(): Promise<void> {
    const saved = this.saved
    if (saved === null) return
    this.saved = null
    const api = await this.loadApi()
    if (api === null) return
    try {
      if (saved.kind === 'layout') {
        if (api.PostMessageW(saved.hwnd, WM_INPUTLANGCHANGEREQUEST, 0, saved.hkl) === 0) {
          this.logger.warn(`[vim] failed to restore input language for hwnd ${saved.hwnd}`)
        }
        return
      }
      if (!this.setConversionMode(api, saved.hwnd, true)) {
        this.logger.warn('[vim] failed to restore the IME conversion mode')
      }
    } catch (error) {
      this.logger.warn('[vim] failed to restore input method', error)
    }
  }

  private setConversionMode(api: Win32Imports, hwnd: number, native: boolean): boolean {
    const threadId = api.GetWindowThreadProcessId(hwnd, [null])
    if (threadId === 0) return false
    const currentThread = api.GetCurrentThreadId()
    // The IME context lives on the window's UI thread; attach before touching it.
    const attached = api.AttachThreadInput(currentThread, threadId, 1) !== 0
    try {
      const himc = api.ImmGetContext(hwnd)
      if (himc === 0) return false
      try {
        const conversion: [number | null] = [null]
        const sentence: [number | null] = [null]
        if (api.ImmGetConversionStatus(himc, conversion, sentence) === 0) return false
        const currentConversion = conversion[0] ?? 0
        if (((currentConversion & IME_CMODE_NATIVE) !== 0) === native) return false
        const nextConversion = native
          ? currentConversion | IME_CMODE_NATIVE
          : currentConversion & ~IME_CMODE_NATIVE
        return api.ImmSetConversionStatus(himc, nextConversion, sentence[0] ?? 0) !== 0
      } finally {
        api.ImmReleaseContext(hwnd, himc)
      }
    } finally {
      if (attached) api.AttachThreadInput(currentThread, threadId, 0)
    }
  }
}
