/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Ctrl+P/N/H/L inside an open context menu.
 *
 *  The unit tests drive the menu through happy-dom, which has no workbench
 *  keybinding handler on `document` capture — the whole point of taking these
 *  keys at the *window* capture phase is beating that handler, and only a real
 *  press proves it. So the assertions here are the leak guards: Ctrl+N must move
 *  the menu highlight without creating an untitled editor, Ctrl+P without
 *  opening quick open. The last step closes the menu and checks Ctrl+P is quick
 *  open again — the listener is torn down with the menu, not merely narrow.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

// After a workspace change the workbench restores focus to the active editor for
// ~1.5s; wait it out so the ContextMenu key lands on the tree (see
// smoke.explorerKeyboardContextMenu).
const RESTORE_WINDOW_MS = 1700

test.describe('@p1 menu ctrl navigation', () => {
  test('Ctrl+P/N drive an open menu without leaking to quick open or new file', async ({
    workbench,
    page,
  }) => {
    const tmpDir = mkTempDir('ue2-menukbd-')
    await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'a')
    await fs.writeFile(path.join(tmpDir, 'beta.txt'), 'b')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    const alpha = page.locator('[role="treeitem"]', { hasText: 'alpha.txt' })
    await expect(alpha).toBeVisible({ timeout: 5000 })

    await alpha.click()
    await expect(alpha).toHaveAttribute('aria-selected', 'true')
    const tree = page.locator('[role="tree"]').filter({ has: alpha }).first()
    await page.waitForTimeout(RESTORE_WINDOW_MS)
    await alpha.click()
    await expect(tree).toHaveAttribute('data-focused', 'true')

    const menus = page.getByRole('menu')
    const active = page.locator('[role="menuitem"][data-active]')
    const editorBefore = await workbench.getActiveEditorUri()

    await page.keyboard.press('ContextMenu')
    await expect(menus).toHaveCount(1)

    // Nothing has been run from this menu yet, so the remembered-row restore is
    // empty and the highlight sits on the first navigable row.
    const first = (await active.textContent()) ?? ''
    expect(first).not.toBe('')

    // Ctrl+N → the menu's own down step. Globally Ctrl+N is New File: the press
    // must not reach it, and must not open quick open either.
    await page.keyboard.press('Control+n')
    await expect(menus).toHaveCount(1)
    await expect(active).not.toHaveText(first)
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(editorBefore)
    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(false)

    // Ctrl+P → back up to where we started (globally quick open).
    await page.keyboard.press('Control+p')
    await expect(menus).toHaveCount(1)
    await expect(active).toHaveText(first)
    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(false)

    // Closed menu = the window-capture listener is gone. Ctrl+P is quick open
    // again, so the aliases only ever shadowed the globals while a menu was up.
    await page.keyboard.press('Escape')
    await expect(menus).toHaveCount(0)
    await page.keyboard.press('Control+p')
    await expect
      .poll(() => workbench.getContextKey<boolean>('quickInputVisible'), { timeout: 5000 })
      .toBe(true)
    await page.keyboard.press('Escape')
  })
})
