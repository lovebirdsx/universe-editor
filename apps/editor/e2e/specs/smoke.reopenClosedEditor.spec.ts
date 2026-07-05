/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Ctrl+Shift+T reopens non-text editors correctly (P1).
 *
 *  Reproduces the bug where reopening a closed non-text editor (e.g. Settings)
 *  via Ctrl+Shift+T created an empty FileEditorInput instead of the original editor.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p1 reopen closed editor (Ctrl+Shift+T)', () => {
  test('reopens a Settings editor with the correct type @regression', async ({ workbench }) => {
    await workbench.waitForRestored()

    // Open the Settings editor
    await workbench.runCommand('workbench.action.openSettings')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 5000,
      })
      .toBe('settings')

    // Close it
    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 5000,
      })
      .not.toBe('settings')

    // Reopen via Ctrl+Shift+T — previously reopened as a blank FileEditorInput (typeId='file')
    await workbench.runCommand('workbench.action.reopenClosedEditor')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 5000,
      })
      .toBe('settings')
  })
})
