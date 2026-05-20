/*---------------------------------------------------------------------------------------------
 *  Visual Regression — 6 stable workbench states.
 *
 *  Baselines live in apps/editor/e2e/baselines/ and are generated on Linux CI
 *  (cross-OS font rendering differs too much to share a single baseline).
 *
 *  Generate / update baselines:
 *    pnpm --filter @universe-editor/editor visual:update
 *
 *  Run against existing baselines:
 *    pnpm --filter @universe-editor/editor test:visual
 *
 *  All tests carry the @visual tag — excluded from the regular e2e suite,
 *  run only when this file is grep-matched.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'

// 4 px margin: sub-pixel / antialiasing drift that still looks identical to a human.
const SCREENSHOT_THRESHOLD = 0.01
const SCREENSHOT_MAX_DIFF_PIXELS = 50

test.describe('@visual workbench', () => {
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForRestored()
  })

  // -----------------------------------------------------------------------
  // 1. Empty workspace — the default state immediately after startup.
  // -----------------------------------------------------------------------
  test('empty workspace', async ({ page }) => {
    await expect(page).toHaveScreenshot('empty-workspace.png', {
      threshold: SCREENSHOT_THRESHOLD,
      maxDiffPixels: SCREENSHOT_MAX_DIFF_PIXELS,
    })
  })

  // -----------------------------------------------------------------------
  // 2. Explorer sidebar expanded via the Activity Bar.
  // -----------------------------------------------------------------------
  test('explorer sidebar open', async ({ page, workbench }) => {
    await workbench.activityBar.click('workbench.view.explorer')
    await workbench.sideBar.root.waitFor({ state: 'visible' })

    await expect(page).toHaveScreenshot('explorer-sidebar.png', {
      threshold: SCREENSHOT_THRESHOLD,
      maxDiffPixels: SCREENSHOT_MAX_DIFF_PIXELS,
    })
  })

  // -----------------------------------------------------------------------
  // 3. Untitled file open in the editor area.
  // -----------------------------------------------------------------------
  test('untitled file in editor', async ({ page, workbench }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible({ timeout: 5_000 })

    // Let Monaco finish rendering the cursor / gutter before capturing.
    await page.waitForTimeout(200)

    await expect(page).toHaveScreenshot('untitled-editor.png', {
      threshold: SCREENSHOT_THRESHOLD,
      maxDiffPixels: SCREENSHOT_MAX_DIFF_PIXELS,
    })
  })

  // -----------------------------------------------------------------------
  // 4. Settings editor open.
  // -----------------------------------------------------------------------
  test('settings editor', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.openSettings')
    })
    await expect
      .poll(() => workbench.getActiveEditorUri(), { timeout: 5_000 })
      .toMatch(/universe:\/settings/)

    await expect(page).toHaveScreenshot('settings-editor.png', {
      threshold: SCREENSHOT_THRESHOLD,
      maxDiffPixels: SCREENSHOT_MAX_DIFF_PIXELS,
    })
  })

  // -----------------------------------------------------------------------
  // 5. QuickInput overlay — file search mode (no '>' prefix).
  // -----------------------------------------------------------------------
  test('quick open overlay', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()

    await expect(page).toHaveScreenshot('quick-open.png', {
      threshold: SCREENSHOT_THRESHOLD,
      maxDiffPixels: SCREENSHOT_MAX_DIFF_PIXELS,
    })

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  // -----------------------------------------------------------------------
  // 6. Command palette overlay — '>' prefix pre-filled.
  // -----------------------------------------------------------------------
  test('command palette overlay', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showCommands')
    })
    await workbench.quickInput.waitForVisible()

    await expect(page).toHaveScreenshot('command-palette.png', {
      threshold: SCREENSHOT_THRESHOLD,
      maxDiffPixels: SCREENSHOT_MAX_DIFF_PIXELS,
    })

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })
})
