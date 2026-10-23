/*---------------------------------------------------------------------------------------------
 *  Command palette item buttons (@p1) — VSCode parity.
 *
 *  Each command row reveals a gear ("Configure Keybinding") on hover; recently
 *  used rows additionally get a × ("Remove from Recently Used"):
 *    - gear closes the palette and opens the Keyboard Shortcuts editor filtered
 *      to `@command:<id>` (both fresh-open and tab-reuse paths)
 *    - × drops the row from the MRU history and the visible list
 *    - 键盘站在同一行上按 Alt+C，与点 × 等价（面板保持打开）
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/sharedApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

function searchBox(page: Page) {
  return page.locator('input[type="search"]')
}

async function openPalette(page: Page, workbench: WorkbenchPO): Promise<void> {
  // Fire-and-forget: showCommands awaits the pick internally.
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.showCommands')
  })
  await workbench.quickInput.waitForVisible()
}

/** Run a command through the palette, which is what puts it into the MRU list. */
async function acceptFromPalette(
  page: Page,
  workbench: WorkbenchPO,
  commandId: string,
  label: RegExp,
): Promise<void> {
  await openPalette(page, workbench)
  await page.keyboard.type(commandId)
  // Scoped to the panel: hidden views in the workbench keep native <option>
  // elements in the DOM, and those match the same role.
  const row = workbench.quickInput.dialog.getByRole('option', { name: label }).first()
  await expect(row).toBeVisible()
  // Hovering moves the cursor onto that row, so Enter cannot accept a neighbour.
  await row.hover()
  await page.keyboard.press('Enter')
  await workbench.quickInput.waitForHidden()
}

test.describe('@p1 command palette item buttons', () => {
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForBootstrapFocusSettled()
  })

  test('gear opens the Keyboard Shortcuts editor filtered to the command', async ({
    page,
    workbench,
  }) => {
    await openPalette(page, workbench)
    // Matches the command id via keywords, narrowing to a single row.
    await page.keyboard.type('showCommands')

    const row = page.getByRole('option', { name: /Show All Commands/ })
    await row.hover()
    await row.getByTestId('quick-input-item-button').click()

    await workbench.quickInput.waitForHidden()
    await expect.poll(() => workbench.getContextKey<boolean>('inKeybindings')).toBe(true)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('keybindings')
    await expect(searchBox(page)).toHaveValue('@command:workbench.action.showCommands')
  })

  test('gear reuses an already-open Keyboard Shortcuts tab and updates its query', async ({
    page,
    workbench,
  }) => {
    await workbench.runCommand('workbench.action.openGlobalKeybindings')
    await expect.poll(() => workbench.getContextKey<boolean>('inKeybindings')).toBe(true)
    await expect(searchBox(page)).toHaveValue('')

    await openPalette(page, workbench)
    await page.keyboard.type('showCommands')
    const row = page.getByRole('option', { name: /Show All Commands/ })
    await row.hover()
    await row.getByTestId('quick-input-item-button').click()

    await workbench.quickInput.waitForHidden()
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(1)
    await expect(searchBox(page)).toHaveValue('@command:workbench.action.showCommands')
  })

  // 同一语义的两条输入路径：鼠标点行尾 ×，以及键盘在高亮行上按 Alt+C。
  // 保留鼠标用例，新增真实按键覆盖，键盘路径不能借 hover 移动光标。
  for (const trigger of ['mouse', 'Alt+C'] as const) {
    test(`close button removes a recently used command from history and the list (${trigger})`, async ({
      page,
      workbench,
    }) => {
      // 通过命令面板执行一次，把它种进 MRU。
      await acceptFromPalette(
        page,
        workbench,
        'workbench.action.files.newUntitledFile',
        /File: New File/,
      )

      await openPalette(page, workbench)
      // 过滤到该行：异步种下的 MRU 排序无论把它放在虚拟列表哪里都保持渲染。
      await page.keyboard.type('newUntitledFile')
      const row = page.getByRole('option', { name: /File: New File/ })
      await expect(row).toBeVisible()
      const removeButton = row.locator('[data-testid="quick-input-item-button"][data-icon-id="x"]')
      await expect(removeButton).toHaveCount(1)

      if (trigger === 'mouse') {
        await row.hover()
        await removeButton.click()
      } else {
        // 键盘场景只依赖列表自身的高亮：先等 aria-selected 真正落在这行，再按键。
        await expect(row).toHaveAttribute('aria-selected', 'true')
        await page.keyboard.press('Alt+c')
      }

      // 行从可见列表消失，面板保持打开。
      await expect(page.getByRole('option', { name: /File: New File/ })).toHaveCount(0)
      await expect(workbench.quickInput.input).toBeFocused()
      await page.keyboard.press('Escape')
      await workbench.quickInput.waitForHidden()

      // 重新打开：命令仍存在（只是不再是最近使用），因此没有 ×。
      await openPalette(page, workbench)
      await page.keyboard.type('newUntitledFile')
      const plainRow = page.getByRole('option', { name: /File: New File/ })
      await expect(plainRow).toBeVisible()
      await expect(
        plainRow.locator('[data-testid="quick-input-item-button"][data-icon-id="x"]'),
      ).toHaveCount(0)
      // 齿轮仍在。
      await expect(
        plainRow.locator('[data-testid="quick-input-item-button"][data-icon-id="settings-gear"]'),
      ).toHaveCount(1)
      await page.keyboard.press('Escape')
      await workbench.quickInput.waitForHidden()
    })
  }

  test('removing a row keeps the cursor on the row that slides up', async ({ page, workbench }) => {
    // Two MRU entries, so the palette opens on a list whose second row has a
    // successor to hand the cursor to.
    await acceptFromPalette(page, workbench, 'workbench.action.files.newUntitledFile', /New File/)
    await acceptFromPalette(
      page,
      workbench,
      'workbench.action.openGlobalKeybindings',
      /Open Keyboard Shortcuts/,
    )

    await openPalette(page, workbench)
    const rows = workbench.quickInput.dialog.getByRole('option')
    await expect(rows.nth(2)).toBeVisible()
    const successorLabel = await rows.nth(2).textContent()
    const list = workbench.quickInput.dialog.getByRole('listbox')
    const scrollBefore = await list.evaluate((el) => el.scrollTop)

    // Remove the second row: resetting the list would put the cursor back on the
    // first one, and scroll the list back to the top.
    //
    // Keyboard + a synthetic click, not `hover()` + `click()`: a real pointer
    // would be left resting on the row that slides up, and Chromium re-fires
    // hover at it after the list re-renders — which moves the cursor there for a
    // reason that has nothing to do with the list staying put.
    await page.keyboard.press('ArrowDown')
    const removeButton = rows
      .nth(1)
      .locator('[data-testid="quick-input-item-button"][data-icon-id="x"]')
    await expect(removeButton).toHaveCount(1)
    await removeButton.dispatchEvent('click')

    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
    expect(await rows.nth(1).textContent()).toBe(successorLabel)
    expect(await list.evaluate((el) => el.scrollTop)).toBe(scrollBefore)
  })
})
