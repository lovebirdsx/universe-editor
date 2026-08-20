/*---------------------------------------------------------------------------------------------
 *  Inline completion enable-flag persistence smoke test (@p1).
 *
 *  验证 toggle 命令写全局 User 设置层，重启后开关状态保持：
 *    1. 首次冷启动 → toggle → 轮询磁盘 settings.json 落盘（UserSettingsSync 异步写盘）
 *    2. 同一 userData 目录二次冷启动 → 快速设置里 inline toggle 保持关闭
 *
 *  自启动模式（每测试自己 launch 两次），照抄 smoke.editorRestore.spec.ts。
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENABLED_EXTENSIONS_ENV,
  INITIAL_SETTINGS,
  launchElectron,
} from '@universe-editor/e2e-harness'
import { MAIN_ENTRY, APP_ROOT, closeApp } from '../fixtures/electronApp.js'
import { expectNoLeaks, evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const TOGGLE = 'ai.inlineCompletion.toggle'
const KEY = 'ai.inlineCompletion.enabled'

function readPersistedEnabled(userDataDir: string): unknown {
  const raw = readFileSync(join(userDataDir, 'settings.json'), 'utf8')
  const obj = JSON.parse(raw) as Record<string, unknown>
  return obj[KEY]
}

async function launchWithState(userDataDir: string, seedSettings = true) {
  if (seedSettings) writeFileSync(join(userDataDir, 'settings.json'), INITIAL_SETTINGS, 'utf8')
  // ELECTRON_RUN_AS_NODE=1 (set by Claude Code's shell) makes Electron behave as
  // plain Node.js, which rejects Chromium-only flags. Unset it so the binary runs
  // as a full Chromium app (mirrors the shared electronApp fixture).
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
  const app = await launchElectron({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: {
      ...inheritedEnv,
      UNIVERSE_E2E: '1',
      NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      [ENABLED_EXTENSIONS_ENV]: '',
    },
  })
  // A failing readiness step must not leak the half-dead app (the test body's
  // own closeApp runs only after this helper returns).
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )
    await evaluateWhenRestored(page)
    return { app, page }
  } catch (err) {
    await closeApp(app)
    throw err
  }
}

test.describe('@p1 inline completion restore', () => {
  test('toggle persists across restart', async () => {
    // Self-launched double cold boot: leave room for the graceful-close +
    // force-kill teardown under full-suite parallel load (see smoke.viewSizes).
    test.setTimeout(120_000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-inline-restore-'))
    try {
      const { app, page } = await launchWithState(userDataDir)
      try {
        // Toggling before UserSettingsSync finishes its cold-start hydration would
        // be lost (its config-event subscription registers at the end of
        // initialize()). whenUserSettingsInitialized gates on exactly that.
        await page.evaluate(() => window.__E2E__!.whenUserSettingsInitialized())
        await page.evaluate((id) => void window.__E2E__!.runCommand(id), TOGGLE)
        // UserSettingsSync writes the layer diff back to settings.json
        // asynchronously — poll the file until the toggle lands on disk.
        await expect.poll(() => readPersistedEnabled(userDataDir), { timeout: 10000 }).toBe(false)
        await expectNoLeaks(page)
      } finally {
        await closeApp(app)
      }

      const second = await launchWithState(userDataDir, false)
      try {
        // The persisted User-layer value must seed the runtime flag.
        await expect
          .poll(() => second.page.evaluate((k) => window.__E2E__!.getConfigurationValue(k), KEY))
          .toBe(false)
        await expect(second.page.getByTestId('titlebar-ai-button')).toBeVisible()
        await second.page.getByTestId('titlebar-ai-button').click()
        await expect
          .poll(() =>
            second.page.getByTestId('ai-quick-settings-inline-toggle').getAttribute('aria-checked'),
          )
          .toBe('false')
        await expectNoLeaks(second.page)
      } finally {
        await closeApp(second.app)
      }
    } finally {
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* noop — temp dir cleanup is best-effort */
      }
    }
  })
})
