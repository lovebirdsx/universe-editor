/*---------------------------------------------------------------------------------------------
 *  Workspace focus restore — opening/restoring a folder with no editors should
 *  leave global shortcuts usable even if a hidden terminal previously owned focus.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'
import { test as coldTest, expect as coldExpect } from '../fixtures/electronApp.js'

const EXPLORER_TREE = 'workbench.view.explorer.tree'

test.describe('@p1 workspace focus restore', () => {
  test('focuses Explorer so physical Ctrl+P opens quick access with no editors', async ({
    page,
    workbench,
  }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-focus-'))
    const expectedPath = tmpDir.replace(/\\/g, '/')

    await workbench.waitForRestored()
    await expect.poll(() => workbench.getActiveEditorUri()).toBeUndefined()

    // The one-shot bootstrap focus restore lands after Restored; wait it out so
    // it can't steal focus back from the terminal we focus next.
    await workbench.waitForBootstrapFocusSettled()

    await workbench.runCommand('workbench.action.terminal.focus')
    await workbench.panel.waitForVisible()
    await workbench.panel.waitForActiveTab('workbench.view.terminal')
    await expect
      .poll(() => workbench.getContextKey<boolean>('terminalFocus'), { timeout: 10_000 })
      .toBe(true)

    await workbench.runCommand('workbench.action.terminal.toggleTerminal')
    await expect.poll(() => workbench.getContextKey<boolean>('panelVisible')).toBe(false)

    await workbench.openWorkspace(tmpDir)
    await expect
      .poll(() => workbench.getCurrentWorkspacePath(), { timeout: 5_000 })
      .toBe(expectedPath)
    await expect.poll(() => workbench.getContextKey<boolean>('hasActiveEditor')).toBe(false)
    await expect.poll(() => workbench.getContextKey<string>('focusedView')).toBe(EXPLORER_TREE)
    await expect.poll(() => workbench.getContextKey<boolean>('terminalFocus')).toBe(false)

    await page.keyboard.press('Control+P')
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toBeFocused()
  })
})

coldTest.describe('cold-start terminal focus', () => {
  coldTest(
    'a fresh window keeps terminalFocus false so physical Ctrl+P opens quick access @regression',
    async ({ page, workbench }) => {
      // Regression: the panel auto-spawns a terminal while hidden on first
      // launch; before terminalFocus became focus-tracker-derived, a transient
      // focus landing in that hidden host left the key stuck true and swallowed
      // every `!terminalFocus` keybinding (Ctrl+P reached the shell instead).
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()

      await coldExpect.poll(() => workbench.getContextKey<boolean>('panelVisible')).toBe(false)
      // Give the background terminal spawn a chance to (wrongly) claim focus.
      await coldExpect
        .poll(() => workbench.getContextKey<boolean>('terminalFocus'), { timeout: 10_000 })
        .toBe(false)

      await page.keyboard.press('Control+P')
      await workbench.quickInput.waitForVisible()
      await coldExpect(workbench.quickInput.input).toBeFocused()

      await page.keyboard.press('Escape')
      await workbench.quickInput.waitForHidden()
    },
  )
})
