import { expect, test } from '../fixtures/sharedApp.js'

test.describe('@p0 editor focus', () => {
  test('keeps focus after closing a group created by split command', async ({
    page,
    workbench,
  }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()

    await workbench.focusActiveEditorGroup()

    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)

    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(1)

    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)

    await page.keyboard.press('Escape')
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
  })
})
