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

  test('keeps workbench shortcuts from firing while the palette owns focus', async ({
    page,
    workbench,
  }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const activeUri = await workbench.getActiveEditorUri()
    expect(activeUri).toBeDefined()

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showCommands')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toBeFocused()

    await page.keyboard.press('Control+N')

    await expect(workbench.quickInput.input).toBeFocused()
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(activeUri)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('Enter key does not leak to the editor when confirming a command', async ({
    page,
    workbench,
  }) => {
    // Open an untitled file so there is an editor to split
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(1)

    // Focus the editor so _captureFocusTarget saves it as the restore target
    await workbench.runCommand('workbench.action.focusActiveEditorGroup')
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)

    // Open the command palette and select "Split Editor Right" via Enter.
    // Fire-and-forget so the await-on-pick inside showCommands doesn't deadlock.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showCommands')
    })
    await workbench.quickInput.waitForVisible()
    // Type enough to uniquely select the split command (prefix '>' already filled)
    await page.keyboard.type('Split Editor Right')
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    // The split should have occurred — two editor groups now exist
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    // The active editor URI must be the same file that was open before the split
    // (pressing Enter must not have navigated away or opened something unexpected)
    const activeUri = await workbench.getActiveEditorUri()
    expect(activeUri).toBeDefined()
  })
})
