/*---------------------------------------------------------------------------------------------
 *  S2 — 颜色主题机制冒烟（P0）。
 *
 *  对照 VSCode 的 contributes.themes + WorkbenchThemeService 链路：
 *  内置 theme-defaults 扩展注册 Universe Dark/Light → 切换主题重生成 --vscode-*
 *  CSS 变量并更新 dataset.theme；Select Color Theme picker 导航即预览、Escape
 *  回滚；workbench.colorCustomizations 即时生效且 'default' 还原注册表默认值。
 *  （主题文件热更新的重载逻辑由 workbenchThemeService 单测覆盖，e2e 不写
 *  app 内置目录以免污染源树。）
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/coreThemesApp.js'

const DARK_SIDEBAR = '#242427'
const LIGHT_SIDEBAR = '#ffffff'

function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  )
}

function sidebarBackground(page: Page): Promise<string> {
  return cssVar(page, '--vscode-sideBar-background')
}

function datasetTheme(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset.theme)
}

test.describe('@p0 themes', () => {
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForBootstrapFocusSettled()
  })

  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorTheme', 'Universe Dark')
      window.__E2E__!.updateConfigValue('workbench.colorCustomizations', {})
    })
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(DARK_SIDEBAR)
  })

  test('switching the color theme regenerates --vscode-* variables and dataset.theme', async ({
    page,
  }) => {
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(DARK_SIDEBAR)
    expect(await datasetTheme(page)).toBe('dark')

    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorTheme', 'Universe Light')
    })
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(LIGHT_SIDEBAR)
    expect(await datasetTheme(page)).toBe('light')
  })

  test('theme picker previews on navigation and rolls back on Escape', async ({
    page,
    workbench,
  }) => {
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(DARK_SIDEBAR)

    // selectTheme awaits the pick — fire-and-forget so the test can drive the UI.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.selectTheme')
    })
    await workbench.quickInput.waitForVisible()

    // Filtering to the light theme activates it, which previews immediately.
    await workbench.quickInput.input.fill('Universe Light')
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(LIGHT_SIDEBAR)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(DARK_SIDEBAR)
  })

  test('theme picker accept persists the selection', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.selectTheme')
    })
    await workbench.quickInput.waitForVisible()
    await workbench.quickInput.input.fill('Universe Light')
    // Filtering/highlighting is async: wait until the preview has applied, which
    // guarantees the light item is active before Enter accepts it.
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(LIGHT_SIDEBAR)
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(LIGHT_SIDEBAR)
    expect(await datasetTheme(page)).toBe('light')
  })

  test('colorCustomizations apply live and "default" restores the registry value', async ({
    page,
  }) => {
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(DARK_SIDEBAR)

    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorCustomizations', {
        'sideBar.background': '#ff0000',
      })
    })
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe('#ff0000')

    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorCustomizations', {
        'sideBar.background': 'default',
      })
    })
    await expect.poll(() => sidebarBackground(page), { timeout: 15000 }).toBe(DARK_SIDEBAR)
  })
})
