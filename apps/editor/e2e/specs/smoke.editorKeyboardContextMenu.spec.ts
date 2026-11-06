/*---------------------------------------------------------------------------------------------
 *  Smoke/regression guard: Shift+F10 and the ContextMenu key open the editor's
 *  MenuRegistry context menu at the caret.
 *
 *  Root cause pinned here: with `contextmenu: false`, Monaco still owns Shift+F10
 *  (`editor.action.showContextMenu`, weight EditorContrib) through its standalone
 *  keybinding service, which preventDefault+stopPropagation()s the keydown and then
 *  no-ops — the browser never dispatches the native contextmenu FileEditor listened
 *  for. FileEditor claims the key in editor.onKeyDown (text-input target phase,
 *  before the container listener) and anchors the menu under the caret.
 *
 *  Not duplicated here: the Explorer spec owns the Chromium keyup-supplement
 *  contract matrix, and the auxiliary-window specs own window/realm plumbing.
 *--------------------------------------------------------------------------------------------*/

import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const BODY = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')

const MENU_LABEL = /Show All Commands|显示所有命令/

test.describe('@p1 editor keyboard context menu', () => {
  test('Shift+F10 and the ContextMenu key open one caret-anchored menu @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const tmpDir = mkTempDir('ue2-editor-kcm-')
    const file = join(tmpDir, 'menu.txt')
    writeFileSync(file, BODY, 'utf8')

    try {
      await page.evaluate(([fsPath]) => window.__E2E__!.openFileUri(fsPath!), [
        file.replace(/\\/g, '/'),
      ] as const)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('menu.txt')
      await expect(workbench.editor.monacoEditor).toBeVisible()

      // Line 1 puts the caret near the editor's top edge. A menu anchored at the
      // focused element's centre (the old native-event fallback) lands far lower,
      // so the box assertions below distinguish a real caret anchor.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1)))
        .toBe(true)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')))
        .toBe(true)

      const menus = page.getByRole('menu')

      const expectKeyboardMenu = async (): Promise<void> => {
        await expect(menus).toHaveCount(1)
        await expect(menus).toContainText(MENU_LABEL)

        // Keyboard-opened: virtual focus on a row, Enter usable at once.
        await expect(page.locator('[role="menuitem"][data-active]')).toHaveCount(1)
        await expect(menus).toHaveAttribute('aria-activedescendant', /.+/)
        // Virtual focus — DOM focus stays in the editor.
        expect(await workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)

        const editorBox = await workbench.editor.fileEditor.boundingBox()
        const menuBox = await menus.boundingBox()
        expect(editorBox).not.toBeNull()
        expect(menuBox).not.toBeNull()
        if (!editorBox || !menuBox) return
        expect(menuBox.x).toBeGreaterThanOrEqual(editorBox.x - 1)
        expect(menuBox.x).toBeLessThanOrEqual(editorBox.x + editorBox.width)
        expect(menuBox.y).toBeGreaterThanOrEqual(editorBox.y - 1)
        expect(menuBox.y).toBeLessThan(editorBox.y + 120)
      }

      await page.keyboard.press('Shift+F10')
      await expectKeyboardMenu()

      await page.keyboard.press('Escape')
      await expect(menus).toHaveCount(0)

      // The ContextMenu key takes the same keydown path; no regression.
      await page.keyboard.press('ContextMenu')
      await expectKeyboardMenu()

      await page.keyboard.press('Escape')
      await expect(menus).toHaveCount(0)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
