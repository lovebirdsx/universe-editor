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
})
