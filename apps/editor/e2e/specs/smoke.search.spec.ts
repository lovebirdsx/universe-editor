/*---------------------------------------------------------------------------------------------
 *  Search result activation smoke (P1).
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const SEARCH = 'workbench.view.search'
const MATCH_LINE = 37
const NEEDLE = 'search-result-single-click-target'

function writeWorkspace(): { dir: string; target: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-search-'))
  const target = join(dir, 'target.txt')
  const content = Array.from({ length: 50 }, (_, index) =>
    index + 1 === MATCH_LINE ? NEEDLE : `line ${index + 1}`,
  ).join('\n')
  writeFileSync(target, content, 'utf8')
  return { dir, target }
}

test.describe('@p1 search', () => {
  test(
    'clicking a result once opens the file and moves the cursor to the match @regression',
    async ({ page, workbench }) => {
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

      await expect.poll(() => workbench.getActiveEditorUri()).toBe(pathToFileURL(target).toString())
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber))
        .toBe(MATCH_LINE)
    },
  )
})
