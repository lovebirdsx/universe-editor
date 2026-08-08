/*---------------------------------------------------------------------------------------------
 *  Keyboard Shortcuts editor smoke (@p1) — VSCode-parity refactor (T9).
 *
 *  Covers the refactored editor end to end:
 *    - open via workbench.action.openGlobalKeybindings + inKeybindings context key
 *    - search filtering (debounced) and Escape-to-clear
 *    - @source:user query syntax (empty user layer → empty state)
 *    - table virtualization (DOM rows << total) + scroll-to-bottom rendering
 *    - define-keybinding keyboard flow writing back to the user layer, then
 *      Delete removing it again (probe-asserted, leaves no residue)
 *    - row context menu entries + Escape dismissal
 *    - Record Keys mode mirroring real keystrokes into the search box
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/sharedApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

const GRID_NAME = 'Keyboard shortcuts'
const SEARCH_PLACEHOLDER = 'Type to search in keybindings'
// A repo-own command with NO default keybinding: its row is unbound, so Enter
// runs the add flow and cleanup never touches a real default binding.
const TARGET_COMMAND = 'workbench.action.openSettingsJson'

function grid(page: Page) {
  return page.getByRole('grid', { name: GRID_NAME })
}

function searchBox(page: Page) {
  return page.locator('input[type="search"]')
}

// Data rows carry aria-selected; the header row does not.
function dataRows(page: Page) {
  return grid(page).locator('[role=row][aria-selected]')
}

async function totalRowCount(page: Page): Promise<number> {
  return Number((await grid(page).getAttribute('aria-rowcount')) ?? '0')
}

async function userEntryCount(page: Page, command: string): Promise<number> {
  return page.evaluate((c) => window.__E2E__!.getUserKeybindingEntries(c).length, command)
}

async function openKeybindingsEditor(workbench: WorkbenchPO): Promise<void> {
  await workbench.runCommand('workbench.action.openGlobalKeybindings')
  await expect.poll(() => workbench.getContextKey<boolean>('inKeybindings')).toBe(true)
}

test.describe('@p1 keybindings editor', () => {
  // Every test drives focus right after startup; the one-shot bootstrap focus
  // restore would otherwise steal it mid-test on a slow machine.
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForBootstrapFocusSettled()
  })

  test('opens via command and sets the inKeybindings context key', async ({ page, workbench }) => {
    await openKeybindingsEditor(workbench)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('keybindings')
    await expect.poll(() => totalRowCount(page)).toBeGreaterThan(0)
    await expect(searchBox(page)).toBeFocused()
  })

  test('filters rows by search text and restores them on clear', async ({ page, workbench }) => {
    await openKeybindingsEditor(workbench)
    let total = 0
    await expect.poll(async () => (total = await totalRowCount(page))).toBeGreaterThan(0)

    await searchBox(page).fill('openGlobalKeybindings')
    let filtered = 0
    await expect.poll(async () => (filtered = await totalRowCount(page))).toBeLessThan(total)
    expect(filtered).toBeGreaterThan(0)
    // A handful of matches all render — virtualization only kicks in on big lists.
    await expect.poll(() => dataRows(page).count()).toBe(filtered)

    // Escape in the search box clears the query (ClearKeybindingsSearchResultsAction).
    // The total itself is a moving target early on (the Monaco action bridge keeps
    // registering commands in the background), so "restored" is asserted relative
    // to the filtered count, not by exact equality with the opening total.
    await searchBox(page).press('Escape')
    await expect(searchBox(page)).toHaveValue('')
    await expect.poll(() => totalRowCount(page)).toBeGreaterThan(filtered)
  })

  test('supports the @source:user query syntax', async ({ page, workbench }) => {
    await openKeybindingsEditor(workbench)
    // Per-worker userData starts with an empty user layer; the define-flow test
    // below removes its own entry again, so this holds regardless of test order.
    const debug = await page.evaluate(() => window.__E2E__!.getUserKeybindingDebug())
    expect(debug.userEntries.length).toBe(0)

    await searchBox(page).fill('@source:user')
    await expect.poll(() => page.getByText('No matching keybindings.').count()).toBe(1)
    await expect.poll(() => grid(page).count()).toBe(0)
  })

  test('virtualizes the table and still renders tail rows after scrolling to bottom', async ({
    page,
    workbench,
  }) => {
    await openKeybindingsEditor(workbench)
    let total = 0
    await expect.poll(async () => (total = await totalRowCount(page))).toBeGreaterThan(0)
    await expect.poll(() => dataRows(page).count()).toBeGreaterThan(0)
    const rendered = await dataRows(page).count()
    expect(rendered).toBeLessThan(total)

    const readRenderedTitles = () =>
      page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '[role="grid"] [role="row"][aria-selected] [role="gridcell"][title]',
          ),
        ].map((el) => el.getAttribute('title') ?? ''),
      )
    const beforeTitles = await readRenderedTitles()
    expect(beforeTitles.length).toBeGreaterThan(0)

    await page.evaluate(() => {
      const g = document.querySelector('[role="grid"]')
      const scroller = [...(g?.querySelectorAll('div') ?? [])].find(
        (d) => d.scrollHeight > d.clientHeight + 50,
      )
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })

    // Tail rows render: the previously visible rows virtualize away, new ones appear.
    await expect
      .poll(async () => {
        const titles = await readRenderedTitles()
        return titles.length > 0 && !titles.includes(beforeTitles[0]!)
      })
      .toBe(true)
  })

  test('defines a keybinding via the keyboard flow and writes it to the user layer', async ({
    page,
    workbench,
  }) => {
    await openKeybindingsEditor(workbench)
    await searchBox(page).fill(`@command:${TARGET_COMMAND}`)
    await expect.poll(() => totalRowCount(page)).toBe(1)
    expect(await userEntryCount(page, TARGET_COMMAND)).toBe(0)

    try {
      // Focus the table (ctrl+down from the search box) and open the Define overlay.
      await page.keyboard.press('Control+ArrowDown')
      await expect.poll(() => workbench.getContextKey<boolean>('keybindingFocus')).toBe(true)
      await page.keyboard.press('Enter')
      await expect
        .poll(() => page.getByRole('dialog', { name: 'Define Keybinding' }).count())
        .toBe(1)

      // Record an obscure combo so nothing else binds it, confirm with Enter.
      await page.keyboard.press('Control+Alt+Shift+8')
      await page.keyboard.press('Enter')

      await expect.poll(() => userEntryCount(page, TARGET_COMMAND)).toBe(1)
      const entries = await page.evaluate(
        (c) => window.__E2E__!.getUserKeybindingEntries(c),
        TARGET_COMMAND,
      )
      expect(entries[0]?.key).toContain('8')

      // Cleanup through the real remove flow: the fresh user row is revealed +
      // selected by the editor, Delete removes it (RemoveKeybindingAction).
      await expect.poll(() => workbench.getContextKey<boolean>('keybindingFocus')).toBe(true)
      await page.keyboard.press('Delete')
      await expect.poll(() => userEntryCount(page, TARGET_COMMAND)).toBe(0)
    } finally {
      // Best-effort restore so a mid-flow failure cannot leak a user binding into
      // later tests on this worker (the @source:user assertion depends on it).
      if ((await userEntryCount(page, TARGET_COMMAND)) > 0) {
        await dataRows(page)
          .first()
          .click()
          .catch(() => {})
        await page
          .evaluate(() => {
            void window.__E2E__!.runCommand('keybindings.editor.resetKeybinding')
          })
          .catch(() => {})
      }
    }
  })

  test('shows the row context menu and closes it with Escape', async ({ page, workbench }) => {
    await openKeybindingsEditor(workbench)
    await expect.poll(() => dataRows(page).count()).toBeGreaterThan(0)

    await dataRows(page).first().click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect.poll(() => menu.count()).toBe(1)
    await expect.poll(() => menu.getByRole('menuitem', { name: 'Copy Command ID' }).count()).toBe(1)
    await expect
      .poll(() => menu.getByRole('menuitem', { name: 'Remove Keybinding' }).count())
      .toBe(1)

    await page.keyboard.press('Escape')
    await expect.poll(() => menu.count()).toBe(0)
  })

  test('record keys mode mirrors real keystrokes into the search box', async ({
    page,
    workbench,
  }) => {
    await openKeybindingsEditor(workbench)
    await expect(searchBox(page)).toBeFocused()

    await searchBox(page).press('Alt+K')
    await expect
      .poll(() => searchBox(page).getAttribute('placeholder'))
      .toBe('Recording Keys. Press Escape to exit.')

    // While recording, keystrokes become a quoted complete-match query instead of
    // firing their commands (ctrl+shift+p must NOT open the command palette).
    await page.keyboard.press('Control+Shift+P')
    await expect.poll(() => searchBox(page).inputValue()).toBe('"ctrl+shift+p"')

    await page.keyboard.press('Escape')
    await expect.poll(() => searchBox(page).getAttribute('placeholder')).toBe(SEARCH_PLACEHOLDER)
  })
})
