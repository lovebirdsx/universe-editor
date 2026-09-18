import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertOffscreenLaunch,
  currentOffscreenInput,
  offscreenVerdict,
  GLOBAL_SETUP_DONE_ENV,
  type OffscreenInput,
} from '../offscreen.js'

const base: OffscreenInput = {
  platform: 'linux',
  display: ':0',
  wsl: true,
  showRequested: false,
  setupDone: false,
}

describe('offscreenVerdict', () => {
  it('非 linux 平台一律放行（Windows/macOS 没有离屏概念）', () => {
    expect(offscreenVerdict({ ...base, platform: 'win32' })).toBe('ok')
    expect(offscreenVerdict({ ...base, platform: 'darwin' })).toBe('ok')
    expect(offscreenVerdict({ ...base, platform: 'win32', wsl: false })).toBe('ok')
  })

  it('无 DISPLAY 时放行——globalSetup 会为它起 Xvfb，缺失由 fatal 错误分类兜底', () => {
    expect(offscreenVerdict({ ...base, display: undefined })).toBe('ok')
    // `DISPLAY= pnpm e2e` 是空串而非未设，Electron 同样视作缺失。
    expect(offscreenVerdict({ ...base, display: '' })).toBe('ok')
  })

  it('显式要求真实窗口时放行（e2e:headed / e2e:ui 走这条）', () => {
    expect(offscreenVerdict({ ...base, showRequested: true })).toBe('ok')
    expect(offscreenVerdict({ ...base, showRequested: true, wsl: false })).toBe('ok')
  })

  it('globalSetup 跑过就放行——含 Xvfb 不可用而降级真实 DISPLAY 的分支', () => {
    expect(offscreenVerdict({ ...base, setupDone: true })).toBe('ok')
    // WSL 未装 xvfb 时 globalSetup 只警告并沿用真实 DISPLAY，标记仍会置位。
    expect(offscreenVerdict({ ...base, setupDone: true, wsl: true })).toBe('ok')
  })

  it('WSL 有 DISPLAY 又没跑过 globalSetup：拦截（窗口会弹到 Windows 桌面）', () => {
    expect(offscreenVerdict(base)).toBe('fail')
  })

  it('非 WSL 桌面有真实 DISPLAY：只警告，不中断', () => {
    expect(offscreenVerdict({ ...base, wsl: false })).toBe('warn')
  })
})

describe('currentOffscreenInput', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('从 DISPLAY 与 UNIVERSE_E2E_* 读出各字段', () => {
    vi.stubEnv('DISPLAY', ':42')
    vi.stubEnv(GLOBAL_SETUP_DONE_ENV, '1')
    vi.stubEnv('UNIVERSE_E2E_SHOW', '1')
    const input = currentOffscreenInput()
    expect(input.display).toBe(':42')
    expect(input.setupDone).toBe(true)
    expect(input.showRequested).toBe(true)
    expect(input.platform).toBe(process.platform)
  })

  it('env 未设时 setupDone / showRequested 为 false', () => {
    vi.stubEnv(GLOBAL_SETUP_DONE_ENV, '')
    vi.stubEnv('UNIVERSE_E2E_SHOW', '')
    const input = currentOffscreenInput()
    expect(input.setupDone).toBe(false)
    expect(input.showRequested).toBe(false)
  })
})

describe('assertOffscreenLaunch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('非 WSL 桌面只警告一次，不中断（冷启 fixture 每用例都会 launch）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = { ...base, wsl: false }
    expect(() => {
      assertOffscreenLaunch(input)
    }).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    assertOffscreenLaunch(input)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('WSL 有 DISPLAY 又没跑过 globalSetup：抛错，指引里给出可用入口', () => {
    expect(() => {
      assertOffscreenLaunch(base)
    }).toThrow(/拦截/)
    const hint = String(
      (() => {
        try {
          assertOffscreenLaunch({ ...base })
        } catch (err) {
          return err
        }
        return ''
      })(),
    )
    // 二次调用只报短消息：完整指引每个 worker 一条就够，避免刷屏。
    expect(hint).toMatch(/已被拦截/)
  })

  it('逃生口：UNIVERSE_E2E_SHOW=1 或 marker 存在时不抛错', () => {
    expect(() => {
      assertOffscreenLaunch({ ...base, showRequested: true })
    }).not.toThrow()
    expect(() => {
      assertOffscreenLaunch({ ...base, setupDone: true })
    }).not.toThrow()
  })

  it('默认参数走真实的 env seams（marker 置位即放行）', () => {
    vi.stubEnv(GLOBAL_SETUP_DONE_ENV, '1')
    expect(() => {
      assertOffscreenLaunch()
    }).not.toThrow()
  })
})
