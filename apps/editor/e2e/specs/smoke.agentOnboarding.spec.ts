/*---------------------------------------------------------------------------------------------
 *  First-run Agent onboarding smoke test (@p1).
 *
 *  验证全新安装首次启动时，FirstRunAgentOnboardingContribution 自动展开右侧
 *  Agents 二级侧边栏，让用户发现编辑器的核心能力。
 *
 *  本 spec 自带一个未 seed `welcome.agentOnboarding.seen` 的全新 userData，
 *  因此不能复用默认 fixture（fixture 默认把该标记置为已见以保证布局确定性）。
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_ROOT, MAIN_ENTRY } from '../fixtures/electronApp.js'
import { expectNoLeaks } from '../pages/WorkbenchPO.js'

test.describe('@p1 first-run agent onboarding', () => {
  test('reveals the Agents secondary sidebar on a brand-new install', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-onboarding-'))
    // Pin language + disable auto-update, but intentionally do NOT seed
    // welcome.agentOnboarding.seen so the first-run reveal fires.
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ 'workbench.language': 'en-US', 'update.mode': 'manual' }, null, 2),
      'utf8',
    )
    const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      cwd: APP_ROOT,
      env: {
        ...inheritedEnv,
        UNIVERSE_E2E: '1',
        NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      },
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('secondarySideBarVisible')), {
          timeout: 5000,
          message: 'secondary sidebar should auto-reveal on first run',
        })
        .toBe(true)
      await expectNoLeaks(page)
    } finally {
      await app.close()
    }
  })
})
