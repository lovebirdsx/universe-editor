/*---------------------------------------------------------------------------------------------
 *  移植版 VSCode 主题冒烟（P0）。
 *
 *  extensions/theme-defaults 的 Dark Modern 与 extensions/theme-monokai 的
 *  Monokai 走与 Universe 主题相同的 contributes.themes 链路：settingsId 即
 *  上游主题 id（workbench.colorTheme: "Monokai"），label 经 package.nls
 *  替换后出现在 picker 中。
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/vscodeThemesApp.js'

const DARK_SIDEBAR = '#242427'
const MONOKAI_SIDEBAR = '#1e1f1c'
const DARK_MODERN_SIDEBAR = '#181818'

function sidebarBackground(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue('--vscode-sideBar-background')
      .trim(),
  )
}

test.describe('@p0 vscode themes', () => {
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForBootstrapFocusSettled()
  })

  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorTheme', 'Universe Dark')
    })
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(DARK_SIDEBAR)
  })

  test('workbench.colorTheme accepts a ported theme id (Monokai)', async ({ page }) => {
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(DARK_SIDEBAR)

    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorTheme', 'Monokai')
    })
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(MONOKAI_SIDEBAR)
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorTheme', 'Dark Modern')
    })
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(DARK_MODERN_SIDEBAR)
  })

  test('theme picker lists the ported theme by its localized label', async ({
    page,
    workbench,
  }) => {
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(DARK_SIDEBAR)

    // selectTheme awaits the pick — fire-and-forget so the test can drive the UI.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.selectTheme')
    })
    await workbench.quickInput.waitForVisible()

    // Filtering by label only matches when package.nls replaced %themeLabel%.
    await workbench.quickInput.input.fill('Monokai')
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(MONOKAI_SIDEBAR)
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(MONOKAI_SIDEBAR)
  })
})
