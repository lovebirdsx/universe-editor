/*---------------------------------------------------------------------------------------------
 *  Breadcrumbs smoke (P1).
 *
 *  Regression for "a background editor group's breadcrumbs show the FOCUSED
 *  group's symbol path": a split view renders one FileEditor — and therefore one
 *  breadcrumb bar — per group, and the outline service keeps one tracker per
 *  group, so the path above a group must come from THAT group's caret. The
 *  service used to follow only the global active editor, which made the left
 *  group's breadcrumbs mirror whatever the right group had scrolled to.
 *
 *  JSON symbols come from the in-renderer worker (no out-of-process LSP cold
 *  start), which keeps the spec cheap.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

/** `alphaChild` sits on line 3 of the 2-space-indented file below. */
const CHILD_LINE = 3
/** `alpha` (its parent) starts on line 2. */
const PARENT_LINE = 2

function writeWorkspace(): {
  dir: string
  pathA: string
  pathB: string
  srcA: string
  srcB: string
} {
  const dir = mkTempDir('universe-editor-e2e-breadcrumbs-')
  const pathA = join(dir, 'a.json')
  const pathB = join(dir, 'b.json')
  const srcDir = join(dir, 'src')
  const srcA = join(srcDir, 'a.json')
  const srcB = join(srcDir, 'b.json')
  const srcNested = join(srcDir, 'nested.json')
  mkdirSync(srcDir)
  writeFileSync(pathA, JSON.stringify({ alpha: { alphaChild: 1 } }, null, 2) + '\n')
  writeFileSync(pathB, JSON.stringify({ beta: { betaChild: 1 } }, null, 2) + '\n')
  writeFileSync(srcA, JSON.stringify({ alpha: { alphaChild: 1 } }, null, 2) + '\n')
  writeFileSync(srcB, JSON.stringify({ beta: { betaChild: 1 } }, null, 2) + '\n')
  writeFileSync(srcNested, JSON.stringify({ nested: 1 }, null, 2) + '\n')
  const toFsPath = (p: string): string => p.replace(/\\/g, '/')
  return {
    dir: toFsPath(dir),
    pathA: toFsPath(pathA),
    pathB: toFsPath(pathB),
    srcA: toFsPath(srcA),
    srcB: toFsPath(srcB),
  }
}

function groupIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-group-id]')).map(
      (el) => el.dataset['groupId'] ?? '',
    ),
  )
}

/** The breadcrumb text of one group, e.g. "a.json alpha alphaChild". */
async function breadcrumbText(page: Page, groupId: string): Promise<string> {
  const crumbs = page.locator(`[data-group-id="${groupId}"] [data-testid="editor-breadcrumbs"]`)
  return (await crumbs.textContent()) ?? ''
}

test.describe('@p1 breadcrumbs', () => {
  test("each editor group's breadcrumbs follow that group's caret @regression", async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    // Focus restore lands after waitForRestored(), and this spec drives focus itself.
    await workbench.waitForBootstrapFocusSettled()

    const { dir, pathA, pathB } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)

    // Open A in the only group, remember which one it is, then split right and
    // open B there — the split copies A into the new group and activates it.
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), pathA)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('a.json')
    const uriA = (await workbench.getActiveEditorUri())!
    await expect.poll(() => workbench.getContextKey<string>('activeEditorLanguageId')).toBe('json')

    const [leftId] = await groupIds(page)
    expect(leftId).toBeTruthy()
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    const rightId = (await groupIds(page)).find((id) => id !== leftId)
    expect(rightId).toBeTruthy()

    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), pathB)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('b.json')
    const uriB = (await workbench.getActiveEditorUri())!
    expect(uriB).not.toBe(uriA)

    // Put the LEFT group's caret inside `alphaChild`, then leave it in the
    // background by focusing the right group.
    await workbench.runCommand('workbench.action.focusLeftGroup')
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriA)
    await page.evaluate((line) => window.__E2E__!.setActiveEditorCursor(line, 5), CHILD_LINE)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineActiveSymbol()), {
        timeout: 20000,
      })
      .toBe('alphaChild')

    await workbench.runCommand('workbench.action.focusRightGroup')
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriB)
    await page.evaluate((line) => window.__E2E__!.setActiveEditorCursor(line, 5), CHILD_LINE)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineActiveSymbol()), {
        timeout: 20000,
      })
      .toBe('betaChild')

    // The focused group shows its own path…
    await expect.poll(() => breadcrumbText(page, rightId!)).toContain('betaChild')
    // …and the background group keeps showing ITS OWN, not the focused one's.
    await expect.poll(() => breadcrumbText(page, leftId!)).toContain('alphaChild')
    expect(await breadcrumbText(page, leftId!)).not.toContain('betaChild')

    // Clicking a background group's breadcrumb activates that group without the
    // activation effect stealing focus back into Monaco.
    const leftCrumbs = page.locator(
      `[data-group-id="${leftId}"] [data-testid="editor-breadcrumbs"]`,
    )
    await leftCrumbs.getByText('a.json', { exact: true }).click()
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriA)
    await expect.poll(() => workbench.getContextKey<boolean>('breadcrumbsActive')).toBe(true)
    await page.keyboard.press('Escape')
  })

  test('file picker opens another file from the clicked segment', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    const { dir, srcA } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), srcA)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('a.json')

    const bar = page.locator('[data-testid="editor-breadcrumbs"]').first()
    await expect(bar.getByText('src', { exact: true })).toBeVisible()
    await bar.getByText('a.json', { exact: true }).click()

    const picker = page.locator('[data-testid="breadcrumbs-file-picker"]')
    await expect(picker).toBeVisible()
    await expect(picker.getByText('b.json', { exact: true })).toBeVisible()
    await picker.getByText('b.json', { exact: true }).click()

    await expect.poll(() => workbench.getActiveEditorUri()).toContain('b.json')
  })

  test('file picker twistie expands without closing the picker', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    const { dir, srcA } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), srcA)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('a.json')

    const bar = page.locator('[data-testid="editor-breadcrumbs"]').first()
    await bar.getByText('src', { exact: true }).click()
    const picker = page.locator('[data-testid="breadcrumbs-file-picker"]')
    await expect(picker).toBeVisible()

    const srcRow = picker.getByRole('treeitem').filter({ hasText: 'src' })
    await expect(srcRow).toHaveAttribute('aria-expanded', 'false')
    await srcRow.getByRole('button', { name: 'Expand folder' }).click()

    // The twistie takes focus in a real browser; the picker must stay open.
    await expect(picker).toBeVisible()
    await expect(srcRow).toHaveAttribute('aria-expanded', 'true')
    await expect(picker.getByText('nested.json', { exact: true })).toBeVisible()

    await srcRow.getByRole('button', { name: 'Collapse folder' }).click()
    await expect(picker).toBeVisible()
    await expect(srcRow).toHaveAttribute('aria-expanded', 'false')
    await expect(picker.getByText('nested.json', { exact: true })).toHaveCount(0)
  })

  test('symbol picker previews, cancels and reveals', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    const { dir, pathA } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), pathA)
    // Place the caret AND wait for the outline in the same poll: the editor can
    // mount before its model loads, and a cursor set on the placeholder model is
    // reset when the file's model swaps in.
    await expect
      .poll(
        () =>
          page.evaluate(
            (line) =>
              window.__E2E__!.setActiveEditorCursor(line, 5) &&
              window.__E2E__!.getOutlineActiveSymbol() === 'alphaChild',
            CHILD_LINE,
          ),
        { timeout: 20000 },
      )
      .toBe(true)

    const openPicker = async (): Promise<void> => {
      await page
        .locator('[data-testid="editor-breadcrumbs"]')
        .first()
        .getByText('alphaChild', { exact: true })
        .click()
      await expect(page.locator('[data-testid="breadcrumbs-symbol-picker"]')).toBeVisible()
    }
    const selected = page.locator(
      '[data-testid="breadcrumbs-symbol-picker"] [role="treeitem"][data-selected="true"]',
    )
    const cursorLine = (): Promise<number | undefined> =>
      page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber)

    await openPicker()
    await expect(selected).toHaveText('alphaChild')
    await page.keyboard.press('ArrowUp')
    await expect(selected).toHaveText('alpha')
    // Preview moves the highlight, not the caret.
    expect(await cursorLine()).toBe(CHILD_LINE)

    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="breadcrumbs-symbol-picker"]')).toHaveCount(0)
    expect(await cursorLine()).toBe(CHILD_LINE)

    await openPicker()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-testid="breadcrumbs-symbol-picker"]')).toHaveCount(0)
    await expect.poll(cursorLine).toBe(PARENT_LINE)
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
  })

  test('breadcrumbs settings hot-update the bar', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    const { dir, srcA } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), srcA)
    await expect
      .poll(
        () =>
          page.evaluate(
            (line) =>
              window.__E2E__!.setActiveEditorCursor(line, 5) &&
              window.__E2E__!.getOutlineActiveSymbol() === 'alphaChild',
            CHILD_LINE,
          ),
        { timeout: 20000 },
      )
      .toBe(true)

    const bar = page.locator('[data-testid="editor-breadcrumbs"]').first()
    const update = (key: string, value: unknown): Promise<void> =>
      page.evaluate(([k, v]) => window.__E2E__!.updateConfigValue(k!, v), [key, value] as const)

    await expect(bar.getByText('src', { exact: true })).toBeVisible()
    await update('breadcrumbs.filePath', 'last')
    await expect(bar.getByText('src', { exact: true })).toHaveCount(0)

    await update('breadcrumbs.symbolPath', 'off')
    await expect(bar.getByText('alphaChild', { exact: true })).toHaveCount(0)

    await update('breadcrumbs.symbolPath', 'on')
    await expect(bar.getByText('alphaChild', { exact: true })).toBeVisible()

    await update('breadcrumbs.icons', false)
    await expect(bar.locator('[data-file-icon]')).toHaveCount(0)

    await update('breadcrumbs.enabled', false)
    await expect(page.locator('[data-testid="editor-breadcrumbs"]')).toHaveCount(0)

    await update('breadcrumbs.enabled', undefined)
    await update('breadcrumbs.filePath', undefined)
    await update('breadcrumbs.symbolPath', undefined)
    await update('breadcrumbs.icons', undefined)
    await expect(page.locator('[data-testid="editor-breadcrumbs"]').first()).toBeVisible()
  })

  test('keyboard commands enter and leave the breadcrumb bar', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    const { dir, pathA } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), pathA)
    await expect.poll(() => workbench.setActiveEditorCursor(1, 1)).toBe(true)
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)

    await page.keyboard.press('Control+Shift+;')
    await expect.poll(() => workbench.getContextKey<boolean>('breadcrumbsActive')).toBe(true)

    await page.keyboard.press('Escape')
    await expect.poll(() => workbench.getContextKey<boolean>('breadcrumbsActive')).toBe(false)
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
  })
})
