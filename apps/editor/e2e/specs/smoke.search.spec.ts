/*---------------------------------------------------------------------------------------------
 *  Search result activation smoke (P1).
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { URI } from '@universe-editor/platform'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const SEARCH = 'workbench.view.search'
const MATCH_LINE = 37
const NEEDLE = 'search-result-single-click-target'

function writeWorkspace(): { dir: string; target: string } {
  const dir = mkTempDir('universe-editor-e2e-search-')
  const target = join(dir, 'target.txt')
  const content = Array.from({ length: 50 }, (_, index) =>
    index + 1 === MATCH_LINE ? NEEDLE : `line ${index + 1}`,
  ).join('\n')
  writeFileSync(target, content, 'utf8')
  return { dir, target }
}

test.describe('@p1 search', () => {
  test('clicking a result once opens the file and moves the cursor to the match @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const { dir, target } = writeWorkspace()
    await workbench.openWorkspace(dir)
    await workbench.activityBar.click(SEARCH)

    const searchView = page.getByTestId('search-view')
    await expect(searchView).toBeVisible()
    await searchView.getByRole('textbox', { name: 'Search', exact: true }).fill(NEEDLE)
    const result = searchView.getByText(NEEDLE)
    await expect(result).toBeVisible({ timeout: 10000 })

    await result.click()

    await expect.poll(() => workbench.getActiveEditorUri()).toBe(URI.file(target).toString())
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber))
      .toBe(MATCH_LINE)
    // Clicking a result hands keyboard focus to the editor; Space is the
    // preview gesture that keeps it in the tree.
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
  })

  test('search re-runs automatically after opening a workspace from an empty window @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    // Query typed in an empty window finds nothing on disk.
    await workbench.activityBar.click(SEARCH)
    const searchView = page.getByTestId('search-view')
    await expect(searchView).toBeVisible()
    await searchView.getByRole('textbox', { name: 'Search', exact: true }).fill(NEEDLE)
    await expect(searchView.getByText('No results found')).toBeVisible()

    // Opening a workspace must re-run the current query without further input.
    const { dir } = writeWorkspace()
    await workbench.openWorkspace(dir)
    await expect(searchView.getByText(NEEDLE)).toBeVisible({ timeout: 10000 })
  })

  test('Space previews the focused result without moving focus @p1', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const { dir, target } = writeWorkspace()
    await workbench.openWorkspace(dir)
    await workbench.activityBar.click(SEARCH)

    const searchView = page.getByTestId('search-view')
    await expect(searchView).toBeVisible()
    const input = searchView.getByRole('textbox', { name: 'Search', exact: true })
    await input.fill(NEEDLE)
    await expect(searchView.getByText(NEEDLE)).toBeVisible({ timeout: 10000 })

    await input.press('Tab')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')

    await expect.poll(() => workbench.getActiveEditorUri()).toBe(URI.file(target).toString())
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber))
      .toBe(MATCH_LINE)
    // The preview opens into the editor but keyboard focus stays on the results.
    await expect(searchView.getByRole('tree', { name: 'Search results' })).toBeFocused()
    expect(await workbench.getContextKey<boolean>('editorFocus')).toBe(false)
  })

  test('Ctrl+Shift+F restores the result opened with Enter @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const { dir, target } = writeWorkspace()
    await workbench.openWorkspace(dir)
    await workbench.activityBar.click(SEARCH)

    const searchView = page.getByTestId('search-view')
    await expect(searchView).toBeVisible()
    const input = searchView.getByRole('textbox', { name: 'Search', exact: true })
    await input.fill(NEEDLE)
    await expect(searchView.getByText(NEEDLE)).toBeVisible({ timeout: 10000 })

    // Tab from the query into the results tree (first row = file), move to the
    // match row and open it — the keyboard path the user reported.
    await input.press('Tab')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(URI.file(target).toString())
    // revealRange focuses the editor once it mounts; wait for that before
    // invoking the command, otherwise the SideBar still owns focus and the
    // action takes its "toggle the sidebar closed" branch.
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)

    await workbench.runCommand('workbench.action.findInFiles')

    const tree = searchView.getByRole('tree', { name: 'Search results' })
    await expect(tree).toBeFocused()
    await expect(tree.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-row-key',
      `match:${URI.file(target).toString()}:0`,
    )
    // Re-focusing must not replace the query with the editor's match selection.
    await expect(input).toHaveValue(NEEDLE)
  })
})
