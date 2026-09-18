/*---------------------------------------------------------------------------------------------
 *  X display guard for config-less `playwright test` invocations.
 *
 *  Playwright resolves playwright.config.* from the CWD only, never from a parent
 *  directory, and silently falls back to built-in defaults when that lookup fails.
 *  Such a run skips globalSetup entirely: no offscreen Xvfb, no tag policy, no linux
 *  preflight, no build guard. On WSL that means Electron renders onto WSLg's real
 *  DISPLAY and every window pops up on the Windows desktop.
 *
 *  globalSetup stamps GLOBAL_SETUP_DONE_ENV — "the config entry point was used" — and
 *  workers inherit it exactly like the DISPLAY/TEMP rewrites it already performs, so a
 *  launch that cannot see the marker came from a config-less invocation. WSL fails
 *  fast, before the window exists; other Linux desktops only get one warning, since a
 *  real DISPLAY there is legitimate and merely lost the shared config knobs.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'

// Stamped by globalSetup. Falsy check, matching the other UNIVERSE_E2E_* seams.
export const GLOBAL_SETUP_DONE_ENV = 'UNIVERSE_E2E_GLOBAL_SETUP_DONE'

let cachedWsl: boolean | undefined

// WSLg exports DISPLAY=:0, so "has a display" is not the same as "wants a real
// window". /proc/version is the gate scripts/wsl/bootstrap.sh uses; a read failure
// counts as non-WSL, keeping the headless-only rule for plain Linux servers.
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (cachedWsl === undefined) {
    try {
      cachedWsl = /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
    } catch {
      cachedWsl = false
    }
  }
  return cachedWsl
}

export interface OffscreenInput {
  readonly platform: NodeJS.Platform
  readonly display: string | undefined
  readonly wsl: boolean
  readonly showRequested: boolean
  readonly setupDone: boolean
}

export type OffscreenVerdict = 'ok' | 'warn' | 'fail'

/** Pure so the platform × display × entry-point matrix stays unit-testable. */
export function offscreenVerdict(input: OffscreenInput): OffscreenVerdict {
  if (input.platform !== 'linux') return 'ok'
  // Unset marker + a display that is not ours is the only hazard. An empty DISPLAY
  // counts as missing (Electron rejects it too) — globalSetup will start Xvfb for it.
  if (input.showRequested || input.setupDone || !input.display) return 'ok'
  return input.wsl ? 'fail' : 'warn'
}

const BARE_LAUNCH_HINT = [
  '[e2e] 拦截：本趟不是经 e2e 配置启动的（globalSetup 未运行），WSL 下 Electron 会把真实窗口弹到 Windows 桌面。',
  '      裸 `playwright test` 只在 cwd 找 config，找不到就用内置默认配置，globalSetup 与其离屏 Xvfb / tag 过滤 / 预检 / 构建守卫一并失效。',
  '      正确入口（在仓库根执行）：',
  '        pnpm e2e specs/a.spec.ts specs/b.spec.ts   # 单个或多个 core spec',
  '        pnpm e2ea specs/a.spec.ts                  # 同上但含 @regression',
  '        pnpm e2e:smoke                             # @p0 冒烟',
  '        pnpm --filter @universe-editor/editor e2eg "<用例标题>"   # 自由 grep 调试',
  '        pnpm e2e:ext @universe-editor/<ext>        # 扩展 suite',
  '      确实要真实窗口：UNIVERSE_E2E_SHOW=1。详见 docs/development/wsl-e2e.md',
].join('\n')

// Per-process dedupe: the cold-launch fixtures start an Electron per test, so an
// always-on report would otherwise repeat once per test case.
let warnedRealDisplay = false
let failureReported = false

/** Reads this process's platform plus the DISPLAY / UNIVERSE_E2E_* env seams. */
export function currentOffscreenInput(): OffscreenInput {
  return {
    platform: process.platform,
    display: process.env['DISPLAY'],
    wsl: isWsl(),
    showRequested: Boolean(process.env['UNIVERSE_E2E_SHOW']),
    setupDone: Boolean(process.env[GLOBAL_SETUP_DONE_ENV]),
  }
}

/**
 * Guard called by launchElectron before `electron.launch` — the single choke point
 * every fixture and self-launching spec goes through. Throwing here means the window
 * is never created, and the error bypasses launch.ts's transient/fatal retry ladder
 * instead of burning its 5/10/20s backoff first. The input is injectable so the
 * verdict branches stay testable off-WSL.
 */
export function assertOffscreenLaunch(input: OffscreenInput = currentOffscreenInput()): void {
  const verdict = offscreenVerdict(input)
  if (verdict === 'ok') return

  if (verdict === 'warn') {
    if (warnedRealDisplay) return
    warnedRealDisplay = true
    console.warn(
      '[e2e] 本进程未经 e2e 配置的 globalSetup 启动：离屏 Xvfb / tag 过滤 / 预检 / 构建守卫未生效，窗口会出现在真实桌面。请改用 `pnpm e2e`。',
    )
    return
  }

  if (failureReported) {
    throw new Error('[e2e] 裸 playwright 启动已被拦截（修复指引见本 worker 首条报错）。')
  }
  failureReported = true
  throw new Error(BARE_LAUNCH_HINT)
}
