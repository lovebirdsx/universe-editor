/*---------------------------------------------------------------------------------------------
 *  Regression spec: a custom editor that registers LATE must still claim files
 *  already opened with the fallback text editor (the "PDF opens as garbage" bug).
 *
 *  Custom-editor bindings register asynchronously — only after the extension host
 *  reports its contributions. A file opened during that startup window (e.g. a
 *  `.pdf` restored from the previous session, or clicked right after launch) falls
 *  to the priority-1 catch-all FileEditorInput and Monaco renders the binary as
 *  text (乱码). The fix: EditorResolverService.registerEditor re-opens any such
 *  open tab in place once a higher-priority editor for its URI exists.
 *
 *  This mirrors the real PDF extension: a restricted-tier custom editor bound to
 *  `*.pdf` with the same `engines` range PDF ships (`>=0.2.0 <1.0.0`), not the
 *  `*`-engines inline extension the webview smoke spec uses. We open the file
 *  BEFORE the provider is live (no polling wait first) to force the race, then
 *  assert the tab self-heals to the custom editor.
 *
 *  @p1 (extension host is a child process, slower than the core workbench path).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import AdmZip from 'adm-zip'
import { test, expect } from '../fixtures/electronApp.js'

const VIEW_TYPE = 'e2ePdf.view'
const MARKER = 'e2e-pdf-custom-editor-rendered'

/** A restricted-tier custom editor for `*.pdf`, matching the real PDF extension's
 *  engines range so it exercises version negotiation the same way. */
async function makePdfEditorVsix(dir: string): Promise<string> {
  const manifest = {
    name: 'e2e-pdf-viewer',
    publisher: 'universe',
    version: '1.0.0',
    engines: { universe: '>=0.2.0 <1.0.0' },
    main: 'dist/extension.js',
    activationEvents: [`onCustomEditor:${VIEW_TYPE}`],
    contributes: {
      customEditors: [
        {
          viewType: VIEW_TYPE,
          displayName: 'E2E PDF',
          selector: [{ filenamePattern: '*.pdf' }],
          priority: 'default',
        },
      ],
    },
  }

  const source = `
    const bridge = globalThis['__universeExtensionHostBridge__']
    exports.activate = (context) => {
      context.subscriptions.push(
        bridge.registerCustomEditorProvider(${JSON.stringify(VIEW_TYPE)}, {
          openCustomDocument: (uri) => ({ uri, dispose() {} }),
          resolveCustomEditor: (_doc, panel) => {
            panel.webview.options = { enableScripts: true }
            panel.webview.html =
              '<!DOCTYPE html><html><head>' +
              '<meta http-equiv="Content-Security-Policy" content="default-src \\'none\\';">' +
              '</head><body><div id="${MARKER}">ok</div></body></html>'
          },
        }),
      )
    }
    exports.deactivate = () => {}
  `

  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('extension/dist/extension.js', Buffer.from(source))
  const vsixPath = path.join(dir, 'e2e-pdf-viewer.vsix')
  await fs.writeFile(vsixPath, zip.toBuffer())
  return vsixPath
}

test.describe('@p1 late custom-editor registration', () => {
  test('a pdf opened before its provider is live self-heals to the custom editor @regression', async ({
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-pdf-race-'))
    const vsixPath = await makePdfEditorVsix(tmpDir)
    const docPath = path.join(tmpDir, 'sample.pdf')
    // Minimal binary-ish PDF body — rendered as text this is garbage.
    await fs.writeFile(docPath, '%PDF-1.4\n\x00\x01\x02 binary body\n%%EOF\n')

    await workbench.waitForRestored()

    const installedId = await workbench.page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      vsixPath,
    )
    expect(installedId).toBe('universe.e2e-pdf-viewer')

    // Open the pdf IMMEDIATELY — do not poll for the binding first. This forces
    // the race: the custom-editor registration is still in flight, so the file
    // opens with the fallback text editor. Before the fix this stayed 'file'
    // forever; the fix upgrades the tab in place once the provider registers.
    await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), docPath)

    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 10000,
      })
      .toBe('customEditor')

    // And the custom editor actually rendered its webview (not a blank shell).
    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    await expect(frame.locator(`#${MARKER}`)).toHaveText('ok', { timeout: 10000 })

    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
