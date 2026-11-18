/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { VimInputMethodMainService, type Win32Imports } from '../vimInputMethodMainService.js'

const ZH_CN_HKL = 0x08040804
const EN_US_HKL = 0x04090409
const HWND = 0x100
const THREAD_ID = 42
const MAIN_THREAD_ID = 7

function createLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  } as never
}

function createApi(overrides: Partial<Win32Imports> = {}): Win32Imports {
  return {
    GetForegroundWindow: () => HWND,
    GetWindowThreadProcessId: () => THREAD_ID,
    GetCurrentThreadId: () => MAIN_THREAD_ID,
    GetKeyboardLayout: () => ZH_CN_HKL,
    LoadKeyboardLayoutW: () => EN_US_HKL,
    PostMessageW: () => 1,
    AttachThreadInput: () => 1,
    ImmGetContext: () => 0,
    ImmGetConversionStatus: () => 0,
    ImmSetConversionStatus: () => 0,
    ImmReleaseContext: () => 1,
    ...overrides,
  }
}

describe('VimInputMethodMainService', () => {
  it('switches through the keyboard layout and restores the saved HKL', async () => {
    const posts: number[][] = []
    const api = createApi({
      PostMessageW: (...args: number[]) => {
        posts.push(args)
        return 1
      },
    })
    const service = new VimInputMethodMainService(createLogger(), async () => api)

    await expect(service.switchToEnglish()).resolves.toBe(true)
    expect(posts).toEqual([[HWND, 0x0050, 0, EN_US_HKL]])

    await service.restore()
    expect(posts).toEqual([
      [HWND, 0x0050, 0, EN_US_HKL],
      [HWND, 0x0050, 0, ZH_CN_HKL],
    ])
  })

  it('reports English without posting when the layout is already en-US', async () => {
    const post = vi.fn(() => 1)
    const api = createApi({
      GetKeyboardLayout: () => EN_US_HKL,
      LoadKeyboardLayoutW: () => EN_US_HKL,
      PostMessageW: post,
    })
    const service = new VimInputMethodMainService(createLogger(), async () => api)

    await expect(service.switchToEnglish()).resolves.toBe(true)
    expect(post).not.toHaveBeenCalled()
  })

  it('is idempotent while a switch is already saved', async () => {
    const post = vi.fn(() => 1)
    const api = createApi({ PostMessageW: post })
    const service = new VimInputMethodMainService(createLogger(), async () => api)

    await service.switchToEnglish()
    await expect(service.switchToEnglish()).resolves.toBe(true)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('falls back to the IME conversion mode when no en-US layout is installed', async () => {
    let conversion = 0x0001
    const setStatus = vi.fn((_himc: number, value: number) => {
      conversion = value
      return 1
    })
    const api = createApi({
      LoadKeyboardLayoutW: () => 0,
      ImmGetContext: () => 0x200,
      ImmGetConversionStatus: (_himc, out) => {
        out[0] = conversion
        return 1
      },
      ImmSetConversionStatus: setStatus,
    })
    const service = new VimInputMethodMainService(createLogger(), async () => api)

    await expect(service.switchToEnglish()).resolves.toBe(true)
    expect(setStatus).toHaveBeenLastCalledWith(0x200, 0, 0)

    await service.restore()
    expect(setStatus).toHaveBeenLastCalledWith(0x200, 0x0001, 0)
  })

  it('attaches and detaches the window thread around the IME context', async () => {
    const attach = vi.fn(() => 1)
    const api = createApi({
      LoadKeyboardLayoutW: () => 0,
      AttachThreadInput: attach,
      ImmGetContext: () => 0x200,
      ImmGetConversionStatus: (_himc, out) => {
        out[0] = 0x0001
        return 1
      },
      ImmSetConversionStatus: () => 1,
    })
    const service = new VimInputMethodMainService(createLogger(), async () => api)

    await service.switchToEnglish()

    expect(attach).toHaveBeenNthCalledWith(1, MAIN_THREAD_ID, THREAD_ID, 1)
    expect(attach).toHaveBeenNthCalledWith(2, MAIN_THREAD_ID, THREAD_ID, 0)
  })

  it('logs and reports false when no IME context is available', async () => {
    const logger = createLogger()
    const api = createApi({ LoadKeyboardLayoutW: () => 0, ImmGetContext: () => 0 })
    const service = new VimInputMethodMainService(logger, async () => api)

    await expect(service.switchToEnglish()).resolves.toBe(false)
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled()
  })

  it('is a silent no-op without a Win32 API (non-Windows)', async () => {
    const logger = createLogger()
    const service = new VimInputMethodMainService(logger, async () => null)

    await expect(service.switchToEnglish()).resolves.toBe(false)
    await expect(service.restore()).resolves.toBeUndefined()
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).not.toHaveBeenCalled()
  })

  it('returns false when the foreground window is unavailable', async () => {
    const api = createApi({ GetForegroundWindow: () => 0 })
    const service = new VimInputMethodMainService(createLogger(), async () => api)

    await expect(service.switchToEnglish()).resolves.toBe(false)
  })
})
