/*---------------------------------------------------------------------------------------------
 *  ACP side tasks — palette gate (@p1).
 *
 *  复现/守卫：`New Side Task`（新建侧边任务）可以基于**当前激活会话**直接创建，
 *  不再要求先划选文本。它的命令面板行挂在 root context key
 *  `activeEditorTypeId == 'acp.session'` 上，**不能**带上 `editorAreaFocus`：
 *  命令面板一打开，焦点就移进 quick input，`editorAreaFocus` 翻成 false，
 *  带上它这一行在面板里会永远搜不到。
 *
 *  这个分裂（root ctx 求值 vs 焦点派生的 key）单测守不住——手搓的
 *  ContextKeyService 无法证明"面板求值那一刻"真实产物的取值。这里补上：
 *  会话编辑器在前台时该行可见，换成文件编辑器后该行消失。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/sharedApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

async function openPalette(page: Page, workbench: WorkbenchPO): Promise<void> {
  // Fire-and-forget: showCommands awaits the pick internally.
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.showCommands')
  })
  await workbench.quickInput.waitForVisible()
  // Without this, a keystroke that never lands leaves an unfiltered list — which
  // would make a later `toHaveCount(0)` pass for the wrong reason.
  await expect(workbench.quickInput.input).toBeFocused()
}

test.describe('@p1 acp side task palette gate', () => {
  test('lists New Side Task only while a session editor is in front', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForBootstrapFocusSettled()
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // 1. Session editor in front → the row survives the palette's focus steal.
    //    Only the row's presence is asserted: running it needs fork support, and
    //    the echo agent deliberately has none.
    await openPalette(page, workbench)
    await page.keyboard.type('workbench.action.agent.newSideTask')
    await expect(
      workbench.quickInput.dialog.getByRole('option', { name: /New Side Task/ }),
    ).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    // 2. A file editor in front → the row is gone.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .not.toBe('acp.session')
    await openPalette(page, workbench)
    await page.keyboard.type('workbench.action.agent.newSideTask')
    // The dialog itself must be up: an empty list proves nothing on its own.
    await expect(workbench.quickInput.dialog).toBeVisible()
    await expect(
      workbench.quickInput.dialog.getByRole('option', { name: /New Side Task/ }),
    ).toHaveCount(0)
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })
})
