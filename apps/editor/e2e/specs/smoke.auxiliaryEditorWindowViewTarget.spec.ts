/*---------------------------------------------------------------------------------------------
 *  Auxiliary editor window view target (P1).
 *
 *  Information views (Outline, Timeline, Explorer auto-reveal, @ / @:) follow the
 *  last-used editor surface, not the focused window. This spec drives the real
 *  window round trip: an editor in an auxiliary window stays the Outline source
 *  while the user focuses the main window's sidebar, accepting an Outline row
 *  brings the auxiliary window forward, and interacting with the main editor
 *  area hands the target back. Markdown gives deterministic heading symbols
 *  without a language-server cold start.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/coreMarkdownApp.js'
import {
  activateMainWindow,
  auxWindows,
  clearFocusRequests,
  focusRequests,
  installFocusProbe,
  markDocumentUnfocused,
  waitForAuxWindow,
} from './helpers/auxiliaryWindow.js'

function seedMarkdown(name: string, content: string): string {
  const dir = mkTempDir('universe-editor-e2e-view-target-')
  const path = join(dir, name)
  writeFileSync(path, content)
  return path.replace(/\\/g, '/')
}

test.describe('auxiliary window view target', () => {
  test('the outline follows the last-used editor surface across windows @p1', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await installFocusProbe(electronApp)

    const alpha = seedMarkdown('alpha.md', '# Alpha\n\n## Alpha Child\n')
    const bravo = seedMarkdown('bravo.md', '# Bravo\n\n## Bravo Child\n')

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })

    // Alpha is the main window's editor; the outline starts on it.
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), alpha)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineUri()), { timeout: 15_000 })
      .toContain('alpha.md')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 15_000 })
      .toEqual(expect.arrayContaining(['# Alpha', '## Alpha Child']))

    // Move Bravo into an auxiliary window: it becomes the last-used surface.
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), bravo)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineUri()), { timeout: 15_000 })
      .toContain('bravo.md')
    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    const token = (await auxWindows(page))[0]!.token
    // The move opens a background window in E2E (no OS focus), so focus it
    // explicitly — this is the "user edits in the auxiliary window" moment.
    await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getViewTargetGroup().isMain))
      .toBe(false)

    // Alt+Tab back to main and focus the Outline (a sidebar interaction): the
    // command target is now the main window, but the view target stays on Bravo.
    await page.evaluate(() => window.__E2E__!.focusMainWindow())
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getViewTargetGroup().isMain))
      .toBe(false)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineUri()))
      .toContain('bravo.md')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()))
      .toEqual(expect.arrayContaining(['# Bravo', '## Bravo Child']))
    await expect(page.getByRole('treeitem', { name: 'Bravo Child' })).toBeVisible({
      timeout: 5000,
    })

    // Accepting a row brings the auxiliary window forward and reveals the symbol
    // in its editor (heading on line 3).
    await markDocumentUnfocused(child)
    await clearFocusRequests(electronApp)
    await page.getByRole('treeitem', { name: 'Bravo Child' }).click()
    await expect
      .poll(async () => (await focusRequests(electronApp)).some((request) => request.auxiliary))
      .toBe(true)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('bravo.md')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorSelection()?.startLineNumber))
      .toBe(3)

    // Clicking the main editor area hands the view target back to main.
    await activateMainWindow(page)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getViewTargetGroup().isMain))
      .toBe(true)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineUri()))
      .toContain('alpha.md')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()))
      .toEqual(expect.arrayContaining(['# Alpha', '## Alpha Child']))

    // Target the auxiliary editor again, then close its window: the target must
    // fall back to a live surface instead of dangling on the removed part.
    await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getViewTargetGroup().isMain))
      .toBe(false)
    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getViewTargetGroup().isMain))
      .toBe(true)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineUri()))
      .toContain('alpha.md')
  })
})
