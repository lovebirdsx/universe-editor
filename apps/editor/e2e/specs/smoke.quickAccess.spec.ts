/*---------------------------------------------------------------------------------------------
 *  S? — Unified QuickAccess prefix routing (P0).
 *
 *  workbench.action.quickOpen 是统一入口, 按输入框前缀路由 provider:
 *  空 = 文件, '@' = 当前文件符号, '>' = 命令, '#' = 工作区符号. 切换前缀时
 *  placeholder 随之变化. gotoSymbol / showAllSymbols 命令直接 prefill 对应前缀.
 *  长任务命令均 fire-and-forget, 避免 await-on-pick 死锁.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, test } from '../fixtures/sharedApp.js'

async function placeholderOf(input: import('@playwright/test').Locator): Promise<string | null> {
  return input.getAttribute('placeholder')
}

test.describe('@p0 quick access', () => {
  // Same bootstrap-focus-restore gate as smoke.commandPalette: typing/focus
  // assertions below must not race the late Explorer focus steal.
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForBootstrapFocusSettled()
  })

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

  test('typing after the prefilled filter appends instead of replacing @regression', async ({
    page,
    workbench,
  }) => {
    // The '#' picker prefills the filter with the editor selection / word under
    // the cursor and selects it. Regression: after the first keystroke replaced
    // the selection, the provider's busy/items state updates re-broadcast the
    // stale valueSelection and the panel re-applied it over the just-typed
    // text — so every further keystroke replaced again ('#Test' → i → '#i' →
    // n → '#n' instead of '#in').
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-quickaccess-'))
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'const TestValue = 1\n')
    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)
    await page.evaluate(
      ([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: true }),
      [path.join(tmpDir, 'a.ts')],
    )
    await expect(workbench.editor.monacoEditor).toBeVisible()
    // Select 'TestValue' (columns 7–15) so the prefill uses the selection.
    await workbench.setActiveEditorSelection(1, 7, 1, 16)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showAllSymbols')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toHaveValue('#TestValue')
    // The prefilled filter text is selected, so the first keystroke replaces it.
    const selection = await workbench.quickInput.input.evaluate((el) => [
      (el as HTMLInputElement).selectionStart,
      (el as HTMLInputElement).selectionEnd,
    ])
    expect(selection).toEqual([1, 10])

    await page.keyboard.type('a')
    await expect(workbench.quickInput.input).toHaveValue('#a')
    // Wait past the provider debounce (150ms) so its busy/items state updates
    // land — the stale-selection re-apply rode those pushes.
    await page.waitForTimeout(400)
    await page.keyboard.type('b')
    await expect(workbench.quickInput.input).toHaveValue('#ab')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
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
