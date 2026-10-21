/*---------------------------------------------------------------------------------------------
 *  Smoke spec: the webview / custom-editor pipeline end-to-end.
 *
 *  Installs a minimal custom-editor extension `.vsix` (registers a provider for a
 *  `viewType` bound to `*.uecustom`), opens a matching file, and asserts the full
 *  new path fires: EditorResolverService dispatches to the CustomEditorInput, the
 *  CustomEditorHost mounts, the extension's `resolveCustomEditor` sets the webview
 *  HTML over RPC, and the sandboxed iframe renders that HTML (a marker element).
 *
 *  The marker is styled by a CSS file the extension serves through `asWebviewUri`
 *  (a `universe-app://` resource): asserting the *computed* style guards the
 *  allow-list-before-render ordering in WebviewElement — a plain inline-HTML check
 *  passes even when every `asWebviewUri` sub-resource 403s (as a real PDF did).
 *
 *  Uses a tiny inline extension rather than the full pdf.js `.vsix` (≈6MB assets +
 *  a real PDF render) so the test stays fast and deterministic in headless CI — it
 *  exercises the same infrastructure the PDF extension rides on.
 *
 *  @p1 (extension host is a child process, slower than the core workbench path).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { test, expect } from '../fixtures/electronApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'
import {
  MARKER,
  MARKER_COLOR,
  PRINT_MARKER,
  SCRIPT_MARKER,
  makeCustomEditorVsix,
} from '../fixtures/customEditorVsix.js'

test.describe('@p1 webview custom editor', () => {
  test('installs a custom-editor extension and renders its webview @regression', async ({
    workbench,
  }) => {
    const tmpDir = mkTempDir('ue2-webview-')
    const vsixPath = await makeCustomEditorVsix(tmpDir)
    const docPath = path.join(tmpDir, 'sample.uecustom')
    await fs.writeFile(docPath, 'irrelevant body — the custom editor ignores it')

    await workbench.waitForRestored()

    const installedId = await workbench.page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      vsixPath,
    )
    expect(installedId).toBe('universe.e2e-custom-editor')

    // The `*.uecustom` binding must be live before we open the file. Opening it
    // activates the extension (onCustomEditor:) and resolves the provider.
    await expect
      .poll(
        async () => {
          await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), docPath)
          return workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())
        },
        { timeout: 10000 },
      )
      .toBe('customEditor')

    // The CustomEditorHost mounted and its iframe exists.
    const frameEl = workbench.page.locator('[data-testid="webview-frame"]')
    await expect(frameEl).toBeVisible({ timeout: 10000 })

    // The extension's HTML actually rendered inside the iframe (allow-same-origin
    // lets Playwright reach into the frame).
    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    const marker = frame.locator(`#${MARKER}`)
    await expect(marker).toHaveText('ok', { timeout: 10000 })

    // The asWebviewUri-served stylesheet loaded: its colour applied. This fails if
    // the `universe-app://` resource 403s (allow-list not granted before render).
    await expect
      .poll(() => marker.evaluate((el) => getComputedStyle(el as HTMLElement).color), {
        timeout: 10000,
      })
      .toBe(MARKER_COLOR)

    // The extension's inline <script> ran. This fails if the iframe inherited the
    // app shell's strict `script-src 'self'` CSP instead of the extension's own —
    // the CSP-inheritance root cause a real about:blank iframe hit.
    await expect(frame.locator(`#${SCRIPT_MARKER}`)).toHaveText('ran', { timeout: 10000 })

    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  // Regression: opening a custom editor must move keyboard focus INTO the iframe
  // (CustomEditorInput.focus → WebviewFocusRegistry), and modifier keystrokes the
  // user presses while focus is inside the webview must still trigger host
  // keybindings — keyboard events don't cross the iframe boundary, so the
  // injected bootstrap forwards them up and WebviewElement replays them on the
  // host document. Guarded by pressing Ctrl+P inside the frame and asserting the
  // host's Quick Open (bound to ctrl+p) opens.
  test('focuses the iframe on open and forwards host shortcuts @regression', async ({
    workbench,
  }) => {
    const tmpDir = mkTempDir('ue2-webview-focus-')
    const vsixPath = await makeCustomEditorVsix(tmpDir)
    const docPath = path.join(tmpDir, 'sample.uecustom')
    await fs.writeFile(docPath, 'irrelevant body — the custom editor ignores it')

    await workbench.waitForRestored()

    const installedId = await workbench.page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      vsixPath,
    )
    expect(installedId).toBe('universe.e2e-custom-editor')

    await expect
      .poll(
        async () => {
          await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), docPath)
          return workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())
        },
        { timeout: 10000 },
      )
      .toBe('customEditor')

    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    await expect(frame.locator(`#${MARKER}`)).toHaveText('ok', { timeout: 10000 })

    // Focus landed on the iframe element (not the group body outside it).
    await expect
      .poll(() => workbench.page.evaluate(() => document.activeElement?.tagName ?? ''), {
        timeout: 10000,
      })
      .toBe('IFRAME')

    // Press Ctrl+P from inside the webview: the bootstrap (a capture-phase window
    // keydown listener) forwards it up to the host, and the ctrl+p binding (Quick
    // Open) fires. A raw keystroke that never left the iframe would leave
    // quickInputVisible false forever. The bootstrap must ALSO
    // stopImmediatePropagation so the webview's own capture listener (pdf.js
    // stamps PRINT_MARKER here) never runs — otherwise Ctrl+P double-fires
    // (host Go to File + in-webview print).
    const defaultPrevented = await frame.locator('body').evaluate((body) => {
      const ev = new KeyboardEvent('keydown', {
        key: 'p',
        code: 'KeyP',
        keyCode: 80,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      body.dispatchEvent(ev)
      return ev.defaultPrevented
    })
    expect(defaultPrevented).toBe(true)

    // The in-webview print listener must NOT have fired (stopImmediatePropagation).
    await expect(frame.locator(`#${PRINT_MARKER}`)).toHaveText('', { timeout: 5000 })

    // The host binding did fire.
    await expect
      .poll(() => workbench.getContextKey<boolean>('quickInputVisible'), { timeout: 10000 })
      .toBe(true)
    await workbench.page.keyboard.press('Escape')

    // Ctrl+W from inside the webview must be neutralised: unblocked, Electron's
    // native close-tab closes the WHOLE WINDOW (not just the tab). The bootstrap
    // must preventDefault it (defaultPrevented === true) so only the forwarded
    // host command (Close Editor) runs. defaultPrevented === false here means the
    // native window-close would have fired — the exact bug this guards.
    const closeTabPrevented = await frame.locator('body').evaluate((body) => {
      const ev = new KeyboardEvent('keydown', {
        key: 'w',
        code: 'KeyW',
        keyCode: 87,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      body.dispatchEvent(ev)
      return ev.defaultPrevented
    })
    expect(closeTabPrevented).toBe(true)

    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  // CustomEditorHost + closes its panel; revealing it again remounts and re-opens
  // a fresh panel. The iframe must re-render the extension HTML — an earlier bug
  // rebuilt the iframe on every html change and postMessaged the HTML to a frame
  // whose loader wasn't ready yet, leaving the revealed webview blank.
  test('re-renders the webview after the tab is hidden and revealed @regression', async ({
    workbench,
  }) => {
    const tmpDir = mkTempDir('ue2-webview-revisit-')
    const vsixPath = await makeCustomEditorVsix(tmpDir)
    const docPath = path.join(tmpDir, 'sample.uecustom')
    await fs.writeFile(docPath, 'irrelevant body — the custom editor ignores it')
    const otherPath = path.join(tmpDir, 'other.txt')
    await fs.writeFile(otherPath, 'plain text to switch away to')

    await workbench.waitForRestored()

    const installedId = await workbench.page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      vsixPath,
    )
    expect(installedId).toBe('universe.e2e-custom-editor')

    const openCustom = async (): Promise<void> => {
      await expect
        .poll(
          async () => {
            await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), docPath)
            return workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())
          },
          { timeout: 10000 },
        )
        .toBe('customEditor')
    }

    const expectRendered = async (): Promise<void> => {
      const frameEl = workbench.page.locator('[data-testid="webview-frame"]')
      await expect(frameEl).toBeVisible({ timeout: 10000 })
      const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
      await expect(frame.locator(`#${MARKER}`)).toHaveText('ok', { timeout: 10000 })
      // The asWebviewUri stylesheet + inline script both landed on this fresh mount.
      await expect
        .poll(
          () =>
            frame.locator(`#${MARKER}`).evaluate((el) => getComputedStyle(el as HTMLElement).color),
          { timeout: 10000 },
        )
        .toBe(MARKER_COLOR)
      await expect(frame.locator(`#${SCRIPT_MARKER}`)).toHaveText('ran', { timeout: 10000 })
    }

    // Open + render once.
    await openCustom()
    await expectRendered()

    // Switch away to a plain text file — the custom editor is hidden/unmounted.
    await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), otherPath)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 10000,
      })
      .toBe('file')

    // Reveal the custom editor again — it must re-render, not stay blank.
    await openCustom()
    await expectRendered()

    // Revealing must also re-focus the iframe: after a background tab is revealed,
    // the webview must respond to keys without a manual focusActiveEditorGroup.
    await expect
      .poll(() => workbench.page.evaluate(() => document.activeElement?.tagName ?? ''), {
        timeout: 10000,
      })
      .toBe('IFRAME')

    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
