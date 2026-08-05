/*---------------------------------------------------------------------------------------------
 *  Extension-dev docs smoke (P1).
 *
 *  The extension-author guide (docs/extension-dev/) ships in the package as a
 *  second doc category next to the user guide. This drives the Help command
 *  and asserts the tab opens the category's README, then clicks a relative
 *  .md link and asserts navigation stays inside the extensionDev category
 *  (in-place, same tab slot) rather than resolving against the user guide.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p1 extension-dev docs', () => {
  test('opens the extension guide and follows a relative .md link', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.openExtensionDocs')
    })
    await expect
      .poll(() => workbench.getActiveEditorUri(), { timeout: 10000 })
      .toContain('universe:/doc/extensionDev/README')

    // The README's journey links (e.g. ./getting-started.md) resolve inside the
    // extensionDev category; navigation reuses the current tab in place.
    await page.getByRole('link', { name: '快速上手' }).first().click()
    await expect
      .poll(() => workbench.getActiveEditorUri(), { timeout: 10000 })
      .toContain('universe:/doc/extensionDev/getting-started')
  })

  test('shows the heading tree in the Outline view', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.openExtensionDocs')
    })
    await expect
      .poll(() => workbench.getActiveEditorUri(), { timeout: 10000 })
      .toContain('universe:/doc/extensionDev/README')

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 10000 })
      .toContain('# Universe Editor 扩展开发')
  })
})
