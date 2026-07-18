/*---------------------------------------------------------------------------------------------
 *  Smoke spec: the webview DIFF pipeline end-to-end (`_workbench.openWebviewDiff`).
 *
 *  Installs a minimal diff-capable custom-editor extension, invokes the internal
 *  `_workbench.openWebviewDiff` command with two content blobs (base64), and
 *  asserts the full new path fires: OpenWebviewDiffAction builds a WebviewDiffInput,
 *  CustomEditorHost mounts it and passes the diff payload to openPanel, the host
 *  hands the extension `panel.diffContext`, and the extension renders both sides'
 *  decoded bytes into the iframe.
 *
 *  This guards the kernel additions for Excel diff (extension-api WebviewPanel
 *  .diffContext + the openWebviewDiff command) without the heavy SheetJS extension.
 *
 *  @p1 (extension host is a child process, slower than the core workbench path).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import AdmZip from 'adm-zip'
import { test, expect } from '../fixtures/electronApp.js'

const VIEW_TYPE = 'e2eDiff.view'
const MARKER = 'e2e-webview-diff-rendered'

/** A restricted-tier extension whose custom editor renders `panel.diffContext`. */
async function makeDiffEditorVsix(dir: string, supportsDiff = false): Promise<string> {
  const manifest = {
    name: 'e2e-webview-diff',
    publisher: 'universe',
    version: '1.0.0',
    engines: { universe: '*' },
    main: 'dist/extension.js',
    activationEvents: [`onCustomEditor:${VIEW_TYPE}`],
    contributes: {
      customEditors: [
        {
          viewType: VIEW_TYPE,
          displayName: 'E2E Diff',
          selector: [{ filenamePattern: '*.uediff' }],
          ...(supportsDiff ? { supportsDiff: true } : {}),
        },
      ],
    },
  }

  // Reads panel.diffContext (present because we open via _workbench.openWebviewDiff)
  // and writes the decoded left/right text into the iframe. The bytes cross as
  // Uint8Array; TextDecoder turns them back into the strings we passed in.
  const source = `
    const bridge = globalThis['__universeExtensionHostBridge__']
    exports.activate = (context) => {
      context.subscriptions.push(
        bridge.registerCustomEditorProvider(${JSON.stringify(VIEW_TYPE)}, {
          openCustomDocument: (uri) => ({ uri, dispose() {} }),
          resolveCustomEditor: (doc, panel) => {
            const dc = panel.diffContext
            const dec = new TextDecoder()
            const left = dc ? dec.decode(dc.left) : 'NO_DIFF'
            const right = dc ? dec.decode(dc.right) : 'NO_DIFF'
            panel.webview.options = { enableScripts: true }
            panel.webview.html =
              '<!doctype html><html><head>' +
              '<meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; style-src \\'unsafe-inline\\';">' +
              '</head><body>' +
              '<div id="${MARKER}" data-left="' + left + '" data-right="' + right + '">' +
              left + '|' + right +
              '</div></body></html>'
          },
        }),
      )
    }
    exports.deactivate = () => {}
  `

  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('extension/dist/extension.js', Buffer.from(source))
  const vsixPath = path.join(dir, 'e2e-webview-diff.vsix')
  await fs.writeFile(vsixPath, zip.toBuffer())
  return vsixPath
}

/** Base64 of a UTF-8 string, for the openWebviewDiff payload. */
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

test.describe('@p1 webview diff', () => {
  test('opens a webview diff via _workbench.openWebviewDiff and renders both sides @regression', async ({
    workbench,
  }) => {
    // Extension host is a child process (Electron-as-node spawn, slow to cold-start
    // on Windows CI); the iframe only mounts after the provider registers over RPC,
    // which the product tolerates up to 15s. Chained ≥15s waits can breach the 30s
    // global test timeout, so lift the ceiling.
    test.slow()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-webviewdiff-'))
    const vsixPath = await makeDiffEditorVsix(tmpDir)

    await workbench.waitForRestored()

    const installedId = await workbench.page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      vsixPath,
    )
    expect(installedId).toBe('universe.e2e-webview-diff')

    const leftUri = 'file:///virtual/left.uediff'
    const rightUri = 'file:///virtual/right.uediff'
    const payload = {
      viewType: VIEW_TYPE,
      title: 'E2E Diff',
      leftUri,
      rightUri,
      leftBase64: b64('LEFT_SIDE'),
      rightBase64: b64('RIGHT_SIDE'),
      pinned: true,
    }

    // Invoke the internal command; the provider registers async on first open, so
    // poll until the WebviewDiffInput becomes the active editor.
    await expect
      .poll(
        async () => {
          await workbench.page.evaluate(
            (p) => window.__E2E__!.runCommand('_workbench.openWebviewDiff', p),
            payload,
          )
          return workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())
        },
        { timeout: 10000 },
      )
      .toBe('webviewDiff')

    // The iframe only mounts once the provider registers over RPC (host child
    // process); CustomEditorHost tolerates this up to 15s, so match that ceiling
    // rather than giving up at 10s while the product is still legitimately waiting.
    const frameEl = workbench.page.locator('[data-testid="webview-frame"]')
    await expect(frameEl).toBeVisible({ timeout: 15000 })

    // The extension decoded panel.diffContext.left/right and rendered them.
    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    const marker = frame.locator(`#${MARKER}`)
    await expect(marker).toHaveText('LEFT_SIDE|RIGHT_SIDE', { timeout: 15000 })

    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('native Explorer compare routes a diff-capable custom editor to a webview diff', async ({
    workbench,
  }) => {
    // Heavier than the sibling: opens a workspace (Restricted Mode) then trusts it,
    // which relaunches the extension host before the provider can register. Lift the
    // 30s global timeout and match the product's 15s provider-wait ceiling below.
    test.slow()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-webviewdiff-native-'))
    const vsixPath = await makeDiffEditorVsix(tmpDir, true)

    // Two real files on disk: the native compare path reads their bytes via
    // IFileService (no extension-provided compare command any more).
    const leftPath = path.join(tmpDir, 'left.uediff')
    const rightPath = path.join(tmpDir, 'right.uediff')
    await fs.writeFile(leftPath, 'LEFT_SIDE', 'utf8')
    await fs.writeFile(rightPath, 'RIGHT_SIDE', 'utf8')

    await workbench.waitForRestored()

    const installedId = await workbench.page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      vsixPath,
    )
    expect(installedId).toBe('universe.e2e-webview-diff')

    await workbench.openWorkspace(tmpDir)

    // Opening a folder enters Restricted Mode (untrusted by default). The test
    // extension declares a `main`, so it is gated off in an untrusted workspace
    // and its custom-editor provider never registers — the diff webview would
    // stay blank (mirroring the real Excel diff extension). Trust the workspace,
    // as a user would, so the host activates it and the provider registers.
    await workbench.runCommand('workbench.trust.grant')

    const toUri = (fsPath: string) => {
      const forward = fsPath.replace(/\\/g, '/')
      const p = forward.startsWith('/') ? forward : `/${forward}`
      return { scheme: 'file', authority: '', path: p, query: '', fragment: '' }
    }
    const left = toUri(leftPath)
    const right = toUri(rightPath)

    // Built-in compare commands — no excel-specific command involved.
    await workbench.runCommand('selectForCompare', { target: left })
    await expect
      .poll(
        async () => {
          await workbench.page.evaluate(
            (r) => window.__E2E__!.runCommand('compareSelected', { target: r }),
            right,
          )
          return workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())
        },
        { timeout: 10000 },
      )
      .toBe('webviewDiff')

    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    const marker = frame.locator(`#${MARKER}`)
    await expect(marker).toHaveText('LEFT_SIDE|RIGHT_SIDE', { timeout: 15000 })

    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
