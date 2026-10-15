/*---------------------------------------------------------------------------------------------
 *  「显示 p4delta 信息」命令：当前生效的 δ 是哪一份（@p1, @regression）。
 *
 *  答案由两半拼出来——五级查找顺序（`resolveP4deltaEngine`，另有单测覆盖）与一次 `--version`
 *  采样——这里钉的是装配：命令跑通，且弹出的 toast 同时带上**引擎自报的版本**与**它被解析出来的
 *  那个路径**。δ fixture 把 `UNIVERSE_P4DELTA_PATH` 指向 fake 脚本，所以来源是 `env`、路径就是
 *  那份脚本，而版本来自它的 clap banner（`p4delta 0.1.6`，形状由 perforceP4deltaContract 钉住）。
 *
 *  toast 上那两段缺一不可：只有版本说明不了「用的是哪一份」，只有路径说明不了「那份到底是什么
 *  版本」——这正是这条命令存在的理由。
 *--------------------------------------------------------------------------------------------*/

import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/perforceApp.js'
import type { SeedFile } from '../fixtures/perforceApp.js'

const tracked: SeedFile = { relPath: 'tracked.txt', content: 'have tracked\n' }

/** fake `--version` 输出的那个 semver（见 perforceP4deltaContract.spec.ts）。 */
const FAKE_VERSION = '0.1.6'

test.describe('@p1 perforce p4delta info', () => {
  test.use({ p4Seeds: { files: [tracked] }, p4delta: {} })

  test('reports the engine in use — its version and path @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)
    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)

    await page.evaluate(() => void window.__E2E__!.runCommand('perforce.p4delta.showInfo'))

    // 一条断言覆盖两半：出现了一条带版本的 toast，且它带着被解析出来的那个引擎路径。
    const toast = page
      .locator('[data-testid="notification-toast-item"]')
      .filter({ hasText: FAKE_VERSION })
    await expect(toast).toContainText('fake-p4delta.mjs', { timeout: 30_000 })
    // 来源也是答案的一部分：`env` = `UNIVERSE_P4DELTA_PATH` 命中的那一级。
    await expect(toast).toContainText(/[（(]env[）)]/)
  })
})
