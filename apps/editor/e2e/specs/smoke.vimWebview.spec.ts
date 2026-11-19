/*---------------------------------------------------------------------------------------------
 *  Vim mode must not take over a webview (@p1).
 *
 *  Wave-3 guard for the decided "no promise for webviews" rule: with Vim on,
 *  focus inside an iframe (the HTML preview here) leaves the workbench surfaces
 *  inactive, so j is typed into the frame instead of moving a list cursor.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const HTML_DOC = '<!DOCTYPE html><html><body><h1 id="title">Hello</h1></body></html>'

async function setVimModeEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(() => window.__E2E__!.whenUserSettingsInitialized())
  await page.evaluate(
    (value) => window.__E2E__!.runCommand('_workbench.updateConfiguration', 'vim.enabled', value),
    enabled,
  )
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.__E2E__!.runCommand('_workbench.getConfiguration', key),
        'vim.enabled',
      ),
    )
    .toBe(enabled)
}

test.describe('@p1 vim webview', () => {
  test('focus inside the html preview iframe keeps Vim out', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimModeEnabled(page, true)

    const dir = mkTempDir('universe-editor-e2e-vimwebview-')
    const htmlFile = join(dir, 'index.html')
    writeFileSync(htmlFile, HTML_DOC, 'utf8')
    await page.evaluate(
      (fsPath) => window.__E2E__!.openFileUri(fsPath),
      htmlFile.replace(/\\/g, '/'),
    )
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.html.openPreview'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 10000 })
      .toBe('html.preview')

    // Clicking preview content moves focus into the iframe.
    const frame = page.frameLocator('[data-testid="html-preview"] iframe')
    await frame.locator('#title').click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('webviewFocus')))
      .toBe(true)
    // The dispatcher clears the active surface when focus leaves the workbench.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('vimSurfaceId')))
      .toBe('')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('vimSurface')))
      .toBe('')

    // j stays in the frame: focus does not fall back to a workbench surface.
    await page.keyboard.press('j')
    const activeTag = await page.evaluate(() => document.activeElement?.tagName.toUpperCase())
    expect(activeTag).toBe('IFRAME')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('vimSurfaceId')))
      .toBe('')
  })
})
