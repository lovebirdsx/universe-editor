/*---------------------------------------------------------------------------------------------
 *  Shared driver helpers for the smoke.vim*.spec.ts family.
 *
 *  Free functions over `page` (not a class) so a spec keeps whichever fixture it
 *  needs (`sharedApp` / `electronApp` / `coreTypescriptSharedApp`) and just
 *  imports what it uses.
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { mkTempDir } from '@universe-editor/e2e-harness'

/** `vim.enabled` is USER scope; the shared fixture resets settings.json between tests. */
export async function setVimEnabled(page: Page, enabled: boolean): Promise<void> {
  // Cold start hydrates user settings after the first frame; a write before
  // that point is lost without a retry (the configuration subscription is
  // registered at the end of initialize()).
  await page.evaluate(() => window.__E2E__!.whenUserSettingsInitialized())
  await page.evaluate(
    (value) => window.__E2E__!.runCommand('_workbench.updateConfiguration', 'vim.enabled', value),
    enabled,
  )
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.__E2E__!.runCommand('_workbench.getConfiguration', key),
        'vim.enabled',
      ),
    )
    .toBe(enabled)
}

/** Icon of the Vim mode status-bar entry (`vim-normal` / `vim-insert` / ...), undefined when Vim is off. */
export async function statusIcon(page: Page): Promise<string | undefined> {
  const entries = await page.evaluate(() => window.__E2E__!.getStatusBarEntries())
  return entries.find((entry) => entry.entryId === 'vim-mode')?.icon
}

/** Text of the Vim mode status-bar entry (`NORMAL` / `INSERT` / `VISUAL` / `V-LINE` / `V-BLOCK` / `TERMINAL`), undefined when Vim is off. */
export async function statusText(page: Page): Promise<string | undefined> {
  const entries = await page.evaluate(() => window.__E2E__!.getStatusBarEntries())
  return entries.find((entry) => entry.entryId === 'vim-mode')?.text
}

/** Text of the `vim-feedback` entry (pending keys or `Unsupported: <key>`), undefined when nothing is shown. */
export async function feedbackText(page: Page): Promise<string | undefined> {
  const entries = await page.evaluate(() => window.__E2E__!.getStatusBarEntries())
  return entries.find((entry) => entry.entryId === 'vim-feedback')?.text
}

/** Open `body` as a plain-text file through a real workspace so Monaco's text focus lands. */
export async function openTextEditor(
  page: Page,
  workbench: { openWorkspace(path: string): Promise<void> },
  body: string,
  prefix = 'universe-editor-e2e-vim-',
): Promise<void> {
  const dir = mkTempDir(prefix)
  const filePath = join(dir, 'vim.txt')
  writeFileSync(filePath, body, 'utf8')
  await workbench.openWorkspace(dir)
  await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')))
    .toBe(true)
}

export const text = (page: Page) => page.evaluate(() => window.__E2E__!.getActiveEditorText())

export const cursor = (page: Page) => page.evaluate(() => window.__E2E__!.getActiveEditorCursor())

export const firstVisibleLine = (page: Page) =>
  page.evaluate(() => window.__E2E__!.getActiveEditorFirstVisibleLine())

export const lastVisibleLine = (page: Page) =>
  page.evaluate(() => window.__E2E__!.getActiveEditorLastVisibleLine())

export const foldingState = (page: Page) =>
  page.evaluate(() => window.__E2E__!.getActiveEditorFoldingState())

export const visibleLineCount = (page: Page) =>
  page.evaluate(() => window.__E2E__!.getActiveEditorVisibleLineCount())

export async function setText(page: Page, body: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((value) => window.__E2E__!.setActiveEditorText(value), body))
    .toBe(true)
}

export function selectedTreeRow(page: Page) {
  return page.locator('[role="treeitem"][aria-selected="true"]')
}

/**
 * Put keyboard focus on an Explorer row and select it.
 *
 * Replaces the old "click, sleep 1700ms, click again" dance. The sleep existed
 * because a workspace change arms WorkspaceFocusRestoreContribution's ~1.5s
 * window, which re-focuses the editor area / Explorer as restore work lands. That
 * window is private renderer state with no probe, but a click that moves focus
 * into the sidebar cancels it (it listens to the focus tracker), and the
 * observable end state — Explorer tree focused + row selected — is exactly what
 * the specs need. So click and retry until that state is observed; a restore that
 * lands between click and check just costs one more iteration.
 */
export async function focusExplorerTree(page: Page, rowName = 'alpha.txt'): Promise<void> {
  const row = page.locator('[role="treeitem"]', { hasText: rowName })
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(async () => {
    await row.click()
    await expect(page.locator('[role="tree"][data-focused="true"]').first()).toBeVisible({
      timeout: 1000,
    })
    await expect(row).toHaveAttribute('aria-selected', 'true', { timeout: 1000 })
    expect(await page.evaluate(() => window.__E2E__!.getContextKey('focusedView'))).toBe(
      'workbench.view.explorer.tree',
    )
  }).toPass({ timeout: 10_000 })
}

/**
 * Negative assertion: `read()` keeps returning the same JSON-comparable value for
 * `forMs`. Needed where the regression is a *delayed* side effect (Monaco unfolds
 * a hidden cursor 200ms after the move via a RunOnceScheduler), so there is no
 * event to await and polling at t=0 would pass before the bug can fire. Unlike a
 * blind sleep it samples throughout and fails at the first deviation.
 */
export async function expectStableFor<T>(
  read: () => Promise<T>,
  expected: T,
  forMs = 500,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + forMs
  do {
    const actual: unknown = await read()
    expect(actual).toEqual(expected)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  } while (Date.now() < deadline)
}
