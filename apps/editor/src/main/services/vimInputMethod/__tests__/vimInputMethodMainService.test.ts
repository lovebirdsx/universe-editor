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

  it('is idempotent while a switch is already saved and English is really active', async () => {
    const post = vi.fn(() => 1)
    let layout = ZH_CN_HKL
    const api = createApi({ PostMessageW: post, GetKeyboardLayout: () => layout })
    const service = new VimInputMethodMainService(createLogger(), async () => api)

    await service.switchToEnglish()
    layout = EN_US_HKL
    await expect(service.switchToEnglish()).resolves.toBe(true)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('re-asserts English when the user switched back by hand, keeping the original layout to restore', async () => {
    const posts: number[][] = []
    // The layout never becomes en-US: the user flipped back to Chinese after the first switch.
    const api = createApi({
      PostMessageW: (...args: number[]) => {
        posts.push(args)
        return 1
      },
    })
    const service = new VimInputMethodMainService(createLogger(), async () => api)

    await service.switchToEnglish()
    await expect(service.switchToEnglish()).resolves.toBe(true)
    expect(posts).toEqual([
      [HWND, 0x0050, 0, EN_US_HKL],
      [HWND, 0x0050, 0, EN_US_HKL],
    ])

    await service.restore()
    expect(posts[2]).toEqual([HWND, 0x0050, 0, ZH_CN_HKL])
  })

  it('re-asserts English in conversion mode when the IME was flipped back to native', async () => {
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

    await service.switchToEnglish()
    conversion = 0x0001
    await expect(service.switchToEnglish()).resolves.toBe(true)
    expect(setStatus).toHaveBeenCalledTimes(2)
    expect(conversion).toBe(0)
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

  it('keeps the saved layout when the restore request fails so a retry still works', async () => {
    let failRestore = false
    const posts: number[][] = []
    const api = createApi({
      PostMessageW: (...args: number[]) => {
        posts.push(args)
        return failRestore ? 0 : 1
      },
    })
    const service = new VimInputMethodMainService(createLogger(), async () => api)

    await service.switchToEnglish()
    failRestore = true
    await service.restore()
    failRestore = false
    await service.restore()

    expect(posts.slice(1)).toEqual([
      [HWND, 0x0050, 0, ZH_CN_HKL],
      [HWND, 0x0050, 0, ZH_CN_HKL],
    ])
    // Restored for real this time: the next restore has nothing to do.
    await service.restore()
    expect(posts).toHaveLength(3)
  })

  it('keeps the saved layout when restore throws', async () => {
    let throwOnRestore = false
    const post = vi.fn(() => {
      if (throwOnRestore) throw new Error('boom')
      return 1
    })
    const service = new VimInputMethodMainService(createLogger(), async () =>
      createApi({ PostMessageW: post }),
    )

    await service.switchToEnglish()
    throwOnRestore = true
    await service.restore()
    throwOnRestore = false
    await service.restore()

    expect(post).toHaveBeenCalledTimes(3)
  })

  it('keeps the saved IME state when the conversion restore fails', async () => {
    let conversion = 0x0001
    let failSet = false
    const setStatus = vi.fn((_himc: number, value: number) => {
      if (failSet) return 0
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

    await service.switchToEnglish()
    failSet = true
    await service.restore()
    failSet = false
    await service.restore()

    expect(conversion).toBe(0x0001)
  })

  it('reports an IME that is already in English mode without saving anything', async () => {
    const setStatus = vi.fn(() => 1)
    const api = createApi({
      LoadKeyboardLayoutW: () => 0,
      ImmGetContext: () => 0x200,
      ImmGetConversionStatus: (_himc, out) => {
        out[0] = 0
        return 1
      },
      ImmSetConversionStatus: setStatus,
    })
    const service = new VimInputMethodMainService(createLogger(), async () => api)

    await expect(service.switchToEnglish()).resolves.toBe(true)
    await service.restore()
    expect(setStatus).not.toHaveBeenCalled()
  })
})
