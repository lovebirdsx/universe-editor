/*---------------------------------------------------------------------------------------------
 *  Swarm review — spreadsheet (xlsx) file diff routes through the Excel webview.
 *
 *  Reproduces the "diff is empty" bug: clicking a binary .xlsx file in a Swarm
 *  review used to go through the text-diff path (p4 print → utf8 string → Monaco),
 *  which corrupts / collapses the zip bytes and shows nothing. The fix reads the two
 *  revisions as raw bytes (base64) and hands them to the diff-capable Excel custom
 *  editor, which parses both workbooks (SheetJS) and renders a cell-level diff.
 *
 *  Installs the REAL Excel extension vsix so the whole pipeline is exercised:
 *  p4 print bytes → base64 → openWebviewDiff → SheetJS parse → rendered diff.
 *
 *  @p1 (extension host is a child process; the review layer talks to the fake p4).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '../fixtures/swarmApp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// The built Excel extension package (declares customEditors *.xlsx supportsDiff).
const EXCEL_VSIX = path.resolve(
  __dirname,
  '../../../../extensions-external/excel-diff/universe.universe-excel-diff-0.1.0.vsix',
)

test.describe('@p1 swarm spreadsheet diff', () => {
  test('clicking an xlsx file in a review opens the Excel webview diff with a cell change', async ({
    page,
    swarm,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const installedId = await page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      EXCEL_VSIX,
    )
    expect(installedId).toBe('universe.universe-excel-diff')

    // The swarm fixture opens a workspace folder → Restricted Mode (untrusted).
    // The Excel extension declares a `main`, so it's gated off until trusted and
    // its custom-editor provider never registers. Trust it, as a user would.
    await workbench.runCommand('workbench.trust.grant')

    // Open the Swarm view and the spreadsheet review (#1003 = "Tune buff table").
    await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()
    const view = page.locator('[data-testid="swarm-reviews-view"]')
    await expect(view).toBeVisible()
    await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'reviews')

    await view
      .locator('[data-testid="swarm-review-row"]', { hasText: 'Tune buff table' })
      .first()
      .click()
    const review = page.locator('[data-testid="swarm-review-editor"]')
    await expect(review.getByText('b.Buff_LevelNew.xlsx')).toBeVisible()

    // Click the file; the provider registers async on first open, so poll until the
    // active editor is the webview diff (not the empty Monaco text diff).
    await review.getByText('b.Buff_LevelNew.xlsx').click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 15000 })
      .toBe('webviewDiff')

    // The Excel extension parsed both revisions and rendered a cell-level diff:
    // the "Level" cell changed 10 → 20, so a `.changed` cell carrying "20" appears.
    const frame = page.frameLocator('[data-testid="webview-frame"]')
    await expect(frame.locator('td.changed', { hasText: '20' }).first()).toBeVisible({
      timeout: 15000,
    })

    await page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
  })
})
