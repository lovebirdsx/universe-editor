/*---------------------------------------------------------------------------------------------
 *  Smoke: the real PDF extension renders a `.pdf` in its webview custom editor.
 *
 *  Loads the extension straight off disk (no vsix install — see fixtures/pdfApp.ts)
 *  so this exercises the SHIPPED extension end-to-end: activation on
 *  `onCustomEditor:pdf.view`, the custom-editor binding for `*.pdf`, and the
 *  pdf.js viewer HTML mounting inside the sandboxed webview iframe.
 *
 *  @p1 (extension host is a child process, slower than the core workbench path).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/pdfApp.js'

test.describe('@p1 pdf viewer', () => {
  test('opens a .pdf in the PDF extension webview custom editor', async ({ workbench }) => {
    // Cold extension host + webview mount; give it room on a loaded CI runner.
    test.slow()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-pdf-'))
    const docPath = path.join(tmpDir, 'sample.pdf')
    // Minimal binary-ish PDF body — rendered as text this would be garbage; the
    // custom editor must claim it and render the pdf.js viewer instead.
    await fs.writeFile(docPath, '%PDF-1.4\n\x00\x01\x02 binary body\n%%EOF\n')

    await workbench.waitForRestored()

    // Open the pdf; the custom-editor binding registers async once the host
    // reports its contributions, so poll until the active editor is the custom
    // editor (not the fallback text editor).
    await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), docPath)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 15000,
      })
      .toBe('customEditor')

    // The pdf.js viewer HTML mounted inside the sandboxed iframe: its outer
    // container (#outerContainer) is a stable structural marker of the viewer.
    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    await expect(frame.locator('#outerContainer')).toBeAttached({ timeout: 15000 })

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
