/*---------------------------------------------------------------------------------------------
 *  S2 — Command palette open / close (P0).
 *
 *  通过 ICommandService 触发 workbench.action.showCommands 打开命令面板,
 *  Esc 后面板应消失.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p0 command palette', () => {
  test('opens via command and closes via Escape', async ({ page, workbench }) => {
    // showCommands awaits the user picking an item, so the runCommand promise
    // would deadlock our waitForVisible. Fire-and-forget the trigger.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showCommands')
    })
    await workbench.quickInput.waitForVisible()

    await expect(workbench.quickInput.input).toBeFocused()

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })
})
