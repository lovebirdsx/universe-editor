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

  test('keeps the clicked TOC entry active after navigating to a lower group @regression', async ({
    page,
  }) => {
    const toc = page.getByTestId('settings-toc')
    const performanceEntry = toc.getByRole('button', { name: 'Performance' })
    await expect(performanceEntry).toBeVisible()

    // The highlight drifts only after rows above the target have been measured:
    // until then the virtualizer's estimate table and the spy agree. Scroll in
    // small steps so the rows passed over render and get measured.
    await page.locator('[data-testid="settings-group-workbench"]').hover()
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 300)
      await page.waitForTimeout(50)
    }

    await performanceEntry.click()

    // Wait until the target header is aligned with the scroller top. That means
    // the measurement reconcile and the final scroll event have landed, so this
    // cannot pass on the click handler's optimistic highlight alone.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const header = document.querySelector('[data-testid="settings-group-performance"]')
          if (!header) return 9999
          let scroller: HTMLElement | null = header.parentElement
          while (scroller) {
            const overflowY = getComputedStyle(scroller).overflowY
            if (overflowY === 'auto' || overflowY === 'scroll') break
            scroller = scroller.parentElement
          }
          if (!scroller) return 9999
          return Math.abs(header.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
        }),
      )
      .toBeLessThan(80)

    await expect(performanceEntry).toHaveAttribute('aria-current', 'true')
    await expect(toc.getByRole('button', { name: 'Search' })).toHaveAttribute(
      'aria-current',
      'false',
    )
  })
})
