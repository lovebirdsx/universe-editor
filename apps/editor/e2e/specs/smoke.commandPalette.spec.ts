/*---------------------------------------------------------------------------------------------
 *  S2 — Command palette open / close + unified prefix mode (P0).
 *
 *  通过 ICommandService 触发 workbench.action.showCommands 打开命令面板,
 *  验证 VSCode 风格的 '>' 前缀已 prefill, Esc 后面板应消失. F1 与 Ctrl+Shift+P
 *  作为统一入口, 不应再出现 Monaco 自带的 quick command.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/electronApp.js'

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

  test('restores editor focus after closing with Escape', async ({ page, workbench }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()

    await workbench.runCommand('workbench.action.focusActiveEditorGroup')
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showCommands')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toBeFocused()
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(false)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
  })

  test('prefills the > prefix to indicate command mode', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showCommands')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toHaveValue('>')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })
})
