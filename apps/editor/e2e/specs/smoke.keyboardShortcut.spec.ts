/*---------------------------------------------------------------------------------------------
 *  S8 — Keyboard shortcut path (P1).
 *
 *  Ctrl+Shift+P 应触发命令面板, 验证 KeybindingsRegistry → CommandsRegistry
 *  → QuickInput 全链路.
 *--------------------------------------------------------------------------------------------*/

import { test } from '../fixtures/electronApp.js'

test.describe('@p1 keyboard shortcut', () => {
  test('Ctrl+Shift+P opens the command palette', async ({ page, workbench }) => {
    // Avoid startup race: send shortcut only after global keybinding listener is mounted.
    await workbench.waitForRestored()
    await page.bringToFront()
    await page.focus('body')

    await page.keyboard.press('Control+Shift+P')
    await workbench.quickInput.waitForVisible()
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })
})
