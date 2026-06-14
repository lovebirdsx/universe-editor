/*---------------------------------------------------------------------------------------------
 *  S? — Unified QuickAccess prefix routing (P0).
 *
 *  workbench.action.quickOpen 是统一入口, 按输入框前缀路由 provider:
 *  空 = 文件, '@' = 当前文件符号, '>' = 命令, '#' = 工作区符号. 切换前缀时
 *  placeholder 随之变化. gotoSymbol / showAllSymbols 命令直接 prefill 对应前缀.
 *  长任务命令均 fire-and-forget, 避免 await-on-pick 死锁.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/sharedApp.js'

async function placeholderOf(input: import('@playwright/test').Locator): Promise<string | null> {
  return input.getAttribute('placeholder')
}

test.describe('@p0 quick access', () => {
  test('quickOpen opens in file mode (empty value) and closes via Escape', async ({
    page,
    workbench,
  }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toBeFocused()
    await expect(workbench.quickInput.input).toHaveValue('')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('switches placeholder as the leading prefix changes', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()
    const filePlaceholder = await placeholderOf(workbench.quickInput.input)

    await page.keyboard.type('@')
    await expect(workbench.quickInput.input).toHaveValue('@')
    await expect.poll(() => placeholderOf(workbench.quickInput.input)).not.toBe(filePlaceholder)
    const symbolPlaceholder = await placeholderOf(workbench.quickInput.input)

    // Replace '@' with '>' → command mode, a distinct placeholder again.
    await workbench.quickInput.input.fill('>')
    await expect(workbench.quickInput.input).toHaveValue('>')
    await expect.poll(() => placeholderOf(workbench.quickInput.input)).not.toBe(symbolPlaceholder)

    // Delete back to empty → file mode placeholder restored.
    await workbench.quickInput.input.fill('')
    await expect.poll(() => placeholderOf(workbench.quickInput.input)).toBe(filePlaceholder)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('gotoSymbol prefills the @ prefix', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.gotoSymbol')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toHaveValue('@')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('showAllSymbols prefills the # prefix', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showAllSymbols')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toHaveValue('#')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('restores editor focus after closing with Escape', async ({ page, workbench }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await workbench.runCommand('workbench.action.focusActiveEditorGroup')
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(false)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
  })
})
