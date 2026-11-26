/*---------------------------------------------------------------------------------------------
 *  Vim mode in the Settings editor (@p1).
 *
 *  Guards the two settings surfaces: the row list (j/k/gg/G move the cursor,
 *  Enter focuses the row's first control, Esc returns to the list) and the TOC
 *  (j/k highlight a group, Enter hands focus back to the rows). The search box
 *  must keep every letter: it is an editable target outside both surfaces.
 *
 *  The shared fixture resets settings.json between tests, so each test enables
 *  Vim itself.
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/sharedApp.js'
import { setVimEnabled } from '../pages/vimHelpers.js'

function focusedRowKey(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () =>
      document.querySelector('[data-key][data-vim-focused="true"]')?.getAttribute('data-key') ??
      undefined,
  )
}

function activeRowKey(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.activeElement?.closest('[data-key]')?.getAttribute('data-key') ?? undefined,
  )
}

test.describe('@p1 vim settings', () => {
  test.beforeEach(async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    await workbench.runCommand('workbench.action.openSettings')
    await expect(page.locator('input[type=search]')).toBeFocused()
  })

  test('row list: j/k move, Enter focuses the control, Esc returns', async ({ page }) => {
    test.slow()
    const list = page.getByTestId('settings-list')
    await expect(list).toBeVisible()

    // Click a group header (no inline control) to hand focus to the list.
    await page.locator('[data-testid^="settings-group-"]').first().click()
    await expect(list).toHaveAttribute('data-focused', 'true')

    await page.keyboard.press('j')
    const first = await focusedRowKey(page)
    expect(first).toBeTruthy()
    await page.keyboard.press('j')
    const second = await focusedRowKey(page)
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)

    await page.keyboard.press('Enter')
    await expect.poll(() => activeRowKey(page)).toBe(second)

    await page.keyboard.press('Escape')
    await expect(list).toBeFocused()
  })

  test('idle Esc from the row list hands focus to the tab strip', async ({ page, workbench }) => {
    test.slow()
    const list = page.getByTestId('settings-list')
    await expect(list).toBeVisible()

    // Click a group header (no inline control) to hand focus to the list.
    await page.locator('[data-testid^="settings-group-"]').first().click()
    await expect(list).toHaveAttribute('data-focused', 'true')
    await expect.poll(() => workbench.getContextKey<string>('vimSurface')).toBe('list')

    // A list hosted in the editor area has no view to fall back to: idle Esc
    // hands focus to the tab strip, like a text editor's idle Esc.
    await page.keyboard.press('Escape')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
      .toBe('tab')
    await expect.poll(() => workbench.getContextKey<string>('vimSurface')).toBe('tabs')
  })

  test('TOC: j/k highlight a group and Enter hands focus to the rows', async ({ page }) => {
    test.slow()
    const toc = page.getByTestId('settings-toc')
    const list = page.getByTestId('settings-list')
    await expect(toc).toBeVisible()

    await toc.focus()
    await expect(toc).toBeFocused()

    const activeLabel = () => toc.locator('[aria-current="true"]').textContent()
    const before = await activeLabel()
    await page.keyboard.press('j')
    await expect.poll(activeLabel).not.toBe(before)

    await page.keyboard.press('Enter')
    await expect(list).toBeFocused()
    await expect(page.locator('[data-key][data-vim-focused="true"]')).toBeAttached()
  })

  test('`/` from the row list and TOC focuses the search box', async ({ page }) => {
    const list = page.getByTestId('settings-list')
    await page.locator('[data-testid^="settings-group-"]').first().click()
    await expect(list).toHaveAttribute('data-focused', 'true')
    await page.keyboard.press('/')
    await expect(page.locator('input[type=search]')).toBeFocused()

    await page.getByTestId('settings-toc').focus()
    await page.keyboard.press('/')
    await expect(page.locator('input[type=search]')).toBeFocused()
  })

  test('search box keeps its own letters', async ({ page }) => {
    const search = page.locator('input[type=search]')
    await search.click()
    await expect(search).toBeFocused()

    await page.keyboard.type('editor.fontSize')
    await expect(search).toHaveValue('editor.fontSize')
    // The letters filtered the list instead of being claimed by the Vim surface.
    await expect(page.locator('[data-tooltip="editor.fontSize"]')).toBeAttached()
  })
})
