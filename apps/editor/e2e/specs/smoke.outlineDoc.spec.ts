/*---------------------------------------------------------------------------------------------
 *  Built-in doc outline smoke (P1).
 *
 *  Regression for "Help: Documentation opens a guide document, but the Outline
 *  view stays empty". The doc is a virtual editor input (no Monaco model, no
 *  language server) whose markdown lives in the docRegistry cache, so the
 *  Outline service must build the heading tree itself. This drives the real
 *  command and asserts both the service observable (the same one the view
 *  renders) and the rendered tree rows.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p1 built-in doc outline', () => {
  test('shows the heading tree for Help: Documentation', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.openDocs')
    })
    await expect
      .poll(() => workbench.getActiveEditorUri(), { timeout: 10000 })
      .toContain('universe:/doc/')

    // Reveal the Outline view so its DOM renders, then both the service and the
    // rendered rows must show the document's headings (the index page's H1 is
    // "文档中心"; only the zh-CN translation exists, so en-US falls back to it).
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 10000 })
      .toContain('# 文档中心')
    await expect(page.getByRole('treeitem', { name: '文档中心' }).first()).toBeVisible({
      timeout: 10000,
    })
  })
})
