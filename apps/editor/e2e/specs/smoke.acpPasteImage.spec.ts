/*---------------------------------------------------------------------------------------------
 *  ACP prompt paste-image regression (@p1).
 *
 *  Repro for "pasting an image into the agent prompt input does nothing".
 *
 *  Root cause: Monaco's `editContext: true` binds a Chromium `EditContext` to the
 *  inner `native-edit-context` div. That element — and its DOM ancestors inside
 *  the Monaco tree — never dispatch `paste` to ordinary `addEventListener`
 *  handlers (EditContext owns the input pipeline), so the old handler on the
 *  editor's own container never fired. The paste still propagates (capture phase)
 *  to the React host div *outside* Monaco's DOM, so the fix listens there and
 *  reads the image from the main-process clipboard.
 *
 *  This test seeds the OS clipboard with a PNG (via the main process), focuses
 *  the prompt editor, does a real Ctrl+V, and asserts an image chip appears.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

// 1×1 red PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test.describe('@p1 acp paste image', () => {
  test('pasting an image into the prompt attaches it as a chip @regression', async ({
    page,
    electronApp,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // Echo agent with image capability so the paste path is not gated off.
    await page.evaluate(
      ([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p, { ECHO_AGENT_IMAGE: '1' }),
      ['echo', ECHO_AGENT_PATH] as const,
    )

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)

    // Seed the OS clipboard with a PNG via the main-process clipboard module.
    await electronApp.evaluate(({ clipboard, nativeImage }, b64) => {
      const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
      clipboard.writeImage(img)
    }, PNG_BASE64)

    // Focus the prompt editor (native-edit-context) and paste for real.
    await page.locator('[data-testid="acp-prompt-drop-host"]').click()
    await page.waitForTimeout(300)
    await page.keyboard.press('Control+V')

    // The chip container appears once the pasted image is attached.
    await expect(page.locator('[data-testid="acp-prompt-image-chips"]')).toBeVisible({
      timeout: 5000,
    })
  })
})
