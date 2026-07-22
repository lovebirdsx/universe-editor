/*---------------------------------------------------------------------------------------------
 *  S? — 标题栏交互 (P1)。
 *
 *  对标 VSCode 标题栏: 中部 Command Center 药丸点击打开 Quick Open;
 *  前进/后退按钮跟随 IHistoryService 的 canGoBack/canGoForward 启用;
 *  右侧布局按钮旁的 ▾ 打开 Configure Layout 下拉, Escape 关闭.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/sharedApp.js'

test.describe('@p1 titlebar', () => {
  test('clicking the command center opens Quick Open', async ({ page, workbench }) => {
    await page.getByTestId('titlebar-command-center').click()
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toBeFocused()
    await expect(workbench.quickInput.input).toHaveValue('')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    // Escape restores focus to the trigger (keyboard focus ⇒ :focus-visible). The
    // ring must be the themed focus border (VSCode-style), never the browser's
    // default white focus ring (outline-style: auto).
    const commandCenter = page.getByTestId('titlebar-command-center')
    await expect(commandCenter).toBeFocused()
    await expect(commandCenter).toHaveCSS('outline-style', 'solid')
    await expect(commandCenter).toHaveCSS('outline-color', 'rgb(0, 112, 224)')
  })

  test('back/forward buttons follow navigation history', async ({ page, workbench }) => {
    const back = page.getByTestId('titlebar-nav-back')
    const forward = page.getByTestId('titlebar-nav-forward')
    await expect(back).toBeDisabled()
    await expect(forward).toBeDisabled()

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(back).toBeEnabled()

    const title = page.getByTestId('titlebar-title')
    const before = await title.textContent()
    await back.click()
    await expect.poll(() => title.textContent()).not.toBe(before)
    await expect(forward).toBeEnabled()
  })

  test('configure layout dropdown lists visibility commands and closes on Escape', async ({
    page,
  }) => {
    const menuButton = page.getByTestId('titlebar-layout-menu')
    await expect(page.getByRole('menuitem', { name: 'Toggle Panel' })).toHaveCount(0)

    await menuButton.click()
    await expect(page.getByRole('menuitem', { name: 'Toggle Panel' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Toggle Primary Side Bar' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: 'Toggle Panel' })).toHaveCount(0)
  })

  test('agent pill is always visible and AI button opens quick settings', async ({ page }) => {
    await expect(page.getByTestId('titlebar-agent-status')).toBeVisible()

    await page.getByTestId('titlebar-ai-button').click()
    await expect(page.getByTestId('ai-quick-settings')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('ai-quick-settings')).toHaveCount(0)
  })
})
