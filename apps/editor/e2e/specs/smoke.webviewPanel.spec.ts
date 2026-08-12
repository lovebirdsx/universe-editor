/*---------------------------------------------------------------------------------------------
 *  Smoke spec: window.createWebviewPanel — the extension-OWNED webview tab.
 *
 *  Unlike the custom-editor path (smoke.webview.spec.ts), here the extension
 *  creates/holds/reveals/disposes a webview panel that is not bound to any file:
 *  a command calls `createWebviewPanel`, the workbench opens a tab whose editor
 *  input identity is `webviewPanel:<handle>`, and the sandboxed iframe renders
 *  the HTML the extension sets. `panel.reveal()` re-activates the tab after the
 *  user switches away, and closing the tab fires the extension's `onDidDispose`
 *  (surfaced through an output channel so the spec can observe it).
 *
 *  @p1 (extension host is a child process, slower than the core workbench path).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import AdmZip from 'adm-zip'
import { test, expect } from '../fixtures/electronApp.js'

const VIEW_TYPE = 'e2eWebviewPanel.view'
const MARKER = 'e2e-webview-panel-rendered'
const CHANNEL = 'E2E Webview Panel'
const DISPOSE_SIGNAL = 'webview-panel-disposed'
const CREATE_COMMAND = 'e2eWebviewPanel.create'
const REVEAL_COMMAND = 'e2eWebviewPanel.reveal'

/** An extension that owns a webview panel via window.createWebviewPanel. */
async function makeWebviewPanelVsix(dir: string): Promise<string> {
  const manifest = {
    name: 'e2e-webview-panel',
    publisher: 'universe',
    version: '1.0.0',
    engines: { universe: '*' },
    main: 'dist/extension.js',
    activationEvents: [`onCommand:${CREATE_COMMAND}`, `onCommand:${REVEAL_COMMAND}`],
    contributes: {
      commands: [
        { command: CREATE_COMMAND, title: 'E2E Webview Panel: Create' },
        { command: REVEAL_COMMAND, title: 'E2E Webview Panel: Reveal' },
      ],
    },
  }

  // Plain CJS module talking to the host bridge global directly (installed
  // extensions have no node_modules — see smoke.webview.spec.ts). The panel is
  // created on the create command; onDidDispose appends a signal line to an
  // output channel the spec polls.
  const source = `
    const bridge = globalThis['__universeExtensionHostBridge__']
    let panel = undefined
    exports.activate = (context) => {
      const channel = bridge.createOutputChannel(${JSON.stringify(CHANNEL)})
      context.subscriptions.push(
        bridge.registerCommand(${JSON.stringify(CREATE_COMMAND)}, () => {
          panel = bridge.createWebviewPanel(
            ${JSON.stringify(VIEW_TYPE)},
            'E2E Panel',
            undefined,
            { enableScripts: true },
          )
          panel.webview.html =
            '<!DOCTYPE html><html><body><div id="${MARKER}">ok</div></body></html>'
          panel.onDidDispose(() => channel.appendLine(${JSON.stringify(DISPOSE_SIGNAL)}))
        }),
        bridge.registerCommand(${JSON.stringify(REVEAL_COMMAND)}, () => {
          if (panel) panel.reveal()
        }),
      )
    }
    exports.deactivate = () => {}
  `

  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('extension/dist/extension.js', Buffer.from(source))
  const vsixPath = path.join(dir, 'e2e-webview-panel.vsix')
  await fs.writeFile(vsixPath, zip.toBuffer())
  return vsixPath
}

test.describe('@p1 webview panel (createWebviewPanel)', () => {
  test('creates, renders, reveals and disposes an extension-owned webview tab', async ({
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-webview-panel-'))
    const vsixPath = await makeWebviewPanelVsix(tmpDir)
    const otherPath = path.join(tmpDir, 'other.txt')
    await fs.writeFile(otherPath, 'plain text to switch away to')

    await workbench.waitForRestored()

    const installedId = await workbench.page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      vsixPath,
    )
    expect(installedId).toBe('universe.e2e-webview-panel')

    // The contributed commands land in the CommandsRegistry only once the
    // post-install host rescan re-indexes contributions — wait for it, or the
    // create command below races the restart and is dropped as unknown.
    await expect
      .poll(() => workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), CREATE_COMMAND), {
        timeout: 10000,
      })
      .toBe(true)

    // The create command activates the extension (onCommand:), which creates
    // the panel; the workbench opens its tab in the active group.
    await workbench.runCommand(CREATE_COMMAND)
    const activeTypeId = () =>
      workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())
    await expect.poll(activeTypeId, { timeout: 10000 }).toBe('webviewPanel')

    // The extension's HTML rendered inside the sandboxed iframe.
    const frameEl = workbench.page.locator('[data-testid="webview-frame"]')
    await expect(frameEl).toBeVisible({ timeout: 10000 })
    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    await expect(frame.locator(`#${MARKER}`)).toHaveText('ok', { timeout: 10000 })

    // Switch away to a plain text file — the panel tab stays open, inactive.
    await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), otherPath)
    await expect.poll(activeTypeId, { timeout: 10000 }).toBe('file')

    // panel.reveal() brings the existing tab back to the front (no re-create).
    await workbench.runCommand(REVEAL_COMMAND)
    await expect.poll(activeTypeId, { timeout: 10000 }).toBe('webviewPanel')
    await expect(frame.locator(`#${MARKER}`)).toHaveText('ok', { timeout: 10000 })

    // Closing the tab disposes the panel and notifies the extension.
    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect
      .poll(
        () =>
          workbench.page.evaluate((name) => window.__E2E__!.getOutputChannelContent(name), CHANNEL),
        { timeout: 10000 },
      )
      .toContain(DISPOSE_SIGNAL)

    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
