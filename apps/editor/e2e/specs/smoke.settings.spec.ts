/*---------------------------------------------------------------------------------------------
 *  Settings editor smoke (P1).
 *
 *  验证图形化设置编辑器的主路径:
 *    - 打开后左侧 TOC 列出设置分组
 *    - 搜索收缩结果并显示计数徽标
 *    - 修改数字设置立即生效 (探针读配置), 搜索词在 tab 来回切换后保留
 *    - gear 菜单 Reset 把值重置回默认 (从用户层删除键)
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/sharedApp.js'

test.describe('@p1 settings editor', () => {
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForBootstrapFocusSettled()
    await workbench.runCommand('workbench.action.openSettings')
    await expect(workbench.page.locator('input[type=search]')).toBeFocused()
  })

  test('opens with a TOC of setting groups', async ({ page }) => {
    const toc = page.getByTestId('settings-toc')
    await expect(toc).toBeVisible()
    await expect.poll(() => toc.locator('button').count()).toBeGreaterThan(4)
    // Group headers render inside the list (virtualized: only the viewport's
    // leading groups are in the DOM initially).
    await expect(page.locator('[data-testid^="settings-group-"]').first()).toBeAttached()
  })

  test('search narrows rows and shows a result count', async ({ page }) => {
    const search = page.locator('input[type=search]')
    await search.fill('editor.fontSize')

    await expect(page.getByTestId('settings-count')).toBeVisible()
    await expect(page.locator('[data-key="editor.fontSize"]')).toBeAttached()
    // Unrelated rows are filtered out.
    await expect(page.locator('[data-key="workbench.colorTheme"]')).toHaveCount(0)
  })

  test('editing a number setting takes effect; query survives a tab round-trip', async ({
    page,
  }) => {
    const search = page.locator('input[type=search]')
    await search.fill('editor.fontSize')

    const input = page.locator('[data-key="editor.fontSize"] input[type=number]')
    await input.fill('20')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getConfigurationValue('editor.fontSize')))
      .toBe(20)
    await expect(page.locator('[data-key="editor.fontSize"][data-modified="true"]')).toBeAttached()

    // Switch away (settings.json) and back — the query must be restored.
    await page.waitForTimeout(300) // let the debounced query write land
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.openSettingsJson')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()))
      .toContain('settings.json')
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.openSettings')
    })

    await expect.poll(() => page.locator('input[type=search]').inputValue()).toBe('editor.fontSize')
    await expect(page.locator('[data-key="editor.fontSize"] input[type=number]')).toHaveValue('20')
  })

  test('gear menu Reset Setting restores the default', async ({ page }) => {
    const search = page.locator('input[type=search]')
    await search.fill('editor.fontSize')

    const input = page.locator('[data-key="editor.fontSize"] input[type=number]')
    await input.fill('22')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getConfigurationValue('editor.fontSize')))
      .toBe(22)

    await page.locator('[data-key="editor.fontSize"] button[aria-label="More Actions"]').click()
    await page.getByRole('menuitem', { name: 'Reset Setting' }).click()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getConfigurationValue('editor.fontSize')))
      .toBe(14)
    await expect(page.locator('[data-key="editor.fontSize"][data-modified="true"]')).toHaveCount(0)
  })
})
