/*---------------------------------------------------------------------------------------------
 *  Command palette item buttons (@p1) — VSCode parity.
 *
 *  Each command row reveals a gear ("Configure Keybinding") on hover; recently
 *  used rows additionally get a × ("Remove from Recently Used"):
 *    - gear closes the palette and opens the Keyboard Shortcuts editor filtered
 *      to `@command:<id>` (both fresh-open and tab-reuse paths)
 *    - × drops the row from the MRU history and the visible list
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

  test('close button removes a recently used command from history and the list', async ({
    page,
    workbench,
  }) => {
    // Seed the MRU by running a command through the palette.
    await openPalette(page, workbench)
    await page.keyboard.type('newUntitledFile')
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await openPalette(page, workbench)
    // Filter to the row: keeps it rendered regardless of where the
    // (asynchronously seeded) MRU ranking would place it in the virtual list.
    await page.keyboard.type('newUntitledFile')
    const row = page.getByRole('option', { name: /File: New File/ })
    await row.hover()
    const removeButton = row.locator('[data-testid="quick-input-item-button"][data-icon-id="x"]')
    await expect(removeButton).toHaveCount(1)
    await removeButton.click()

    // The row leaves the visible list while the palette stays open.
    await expect(page.getByRole('option', { name: /File: New File/ })).toHaveCount(0)
    await expect(workbench.quickInput.input).toBeFocused()
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    // Reopening shows the row again (it is still a command) but no longer as
    // recently used — no × button.
    await openPalette(page, workbench)
    await page.keyboard.type('newUntitledFile')
    const plainRow = page.getByRole('option', { name: /File: New File/ })
    await plainRow.hover()
    await expect(
      plainRow.locator('[data-testid="quick-input-item-button"][data-icon-id="x"]'),
    ).toHaveCount(0)
    // The gear remains.
    await expect(
      plainRow.locator('[data-testid="quick-input-item-button"][data-icon-id="settings-gear"]'),
    ).toHaveCount(1)
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

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
