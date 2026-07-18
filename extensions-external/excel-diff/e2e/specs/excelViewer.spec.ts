/*---------------------------------------------------------------------------------------------
 *  Smoke: the real Excel extension renders a spreadsheet viewer and a cell-level diff.
 *
 *  Loads the extension straight off disk (no vsix install — see fixtures/excelApp.ts)
 *  so this exercises the SHIPPED extension end-to-end: activation on
 *  `onCustomEditor:universe.excel`, SheetJS parsing of real .xlsx bytes, and the
 *  webview painting a table (view mode) / a side-by-side cell diff (diff mode).
 *
 *  @p1 (extension host is a child process, slower than the core workbench path).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/excelApp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.resolve(__dirname, '../fixtures/assets')

/** Base64 of a file's raw bytes, for the openWebviewDiff payload. */
async function b64(file: string): Promise<string> {
  return (await fs.readFile(file)).toString('base64')
}

test.describe('@p1 excel viewer & diff', () => {
  test('opens an .xlsx in the Excel webview viewer and renders a table', async ({ workbench }) => {
    test.slow()
    // View mode reads the file via `workspace.fs`, which requires an open
    // workspace folder — so open a folder holding the xlsx (not a bare file).
    const wsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-excel-view-'))
    const docPath = path.join(wsDir, 'buff.xlsx')
    await fs.copyFile(path.join(ASSETS, 'buff-base.xlsx'), docPath)

    await workbench.waitForRestored()
    await workbench.openWorkspace(wsDir)

    // Opening a folder enters Restricted Mode (untrusted): the extension declares
    // a `main`, so it's gated off until trusted and its custom-editor provider
    // never registers. Trust it, as a user would.
    await workbench.runCommand('workbench.trust.grant')

    // The custom-editor binding registers async once the host reports its
    // contributions; poll until the active editor is the Excel custom editor.
    await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), docPath)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 15000,
      })
      .toBe('customEditor')

    // SheetJS parsed the workbook and the webview painted a table with data cells.
    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    await expect(frame.locator('table td').first()).toBeVisible({ timeout: 15000 })

    await fs.rm(wsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('renders a cell-level diff via _workbench.openWebviewDiff @regression', async ({
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    const payload = {
      viewType: 'universe.excel',
      title: 'Buff diff',
      leftUri: 'file:///virtual/buff-base.xlsx',
      rightUri: 'file:///virtual/buff-shelf.xlsx',
      leftBase64: await b64(path.join(ASSETS, 'buff-base.xlsx')),
      rightBase64: await b64(path.join(ASSETS, 'buff-shelf.xlsx')),
      pinned: true,
    }

    // The provider registers async on first open; poll invoking the command until
    // the active editor becomes the webview diff (not an empty Monaco text diff).
    await expect
      .poll(
        async () => {
          await workbench.page.evaluate(
            (p) => window.__E2E__!.runCommand('_workbench.openWebviewDiff', p),
            payload,
          )
          return workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())
        },
        { timeout: 15000 },
      )
      .toBe('webviewDiff')

    // The extension parsed both workbooks and rendered a modified cell: the
    // buff-base → buff-shelf edit changes a "Level" value 10 → 20 (mirrors the
    // perforce swarm spreadsheet fixture), so a `.changed` cell carrying 20 appears.
    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    await expect(frame.locator('td.changed', { hasText: '20' }).first()).toBeVisible({
      timeout: 15000,
    })
  })
})
