/*---------------------------------------------------------------------------------------------
 *  Vim interaction feedback (@p1).
 *
 *  What the user sees and feels around the editor's Vim core, not the key tables
 *  themselves: the status-bar mode text (VISUAL / V-LINE), text objects and `.`
 *  repeat, the which-key overlay after the leader, the keymap cheat sheet, the
 *  idle-Escape hand-off to the editor tab strip, and the `Unsupported:` notice.
 *
 *  The setting is USER scope and the shared fixture rewrites settings.json
 *  between tests, so each test opts in on its own.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'
import {
  cursor,
  expectStableFor,
  feedbackText,
  openTextEditor,
  setText,
  setVimEnabled,
  statusText,
  text,
} from '../pages/vimHelpers.js'

const BODY = 'alpha beta\ngamma delta\nepsilon zeta\n'

test.describe('vim interaction', () => {
  test('v / V show VISUAL / V-LINE in the status bar and Escape returns to NORMAL @p1', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openTextEditor(page, workbench, BODY)
    await setVimEnabled(page, true)
    await expect.poll(() => statusText(page)).toBe('NORMAL')
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))

    await page.keyboard.press('v')
    await expect.poll(() => statusText(page)).toBe('VISUAL')
    // Visual flavours are Normal-class for the context keys.
    await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('normal')
    await page.keyboard.press('Escape')
    await expect.poll(() => statusText(page)).toBe('NORMAL')

    await page.keyboard.press('V')
    await expect.poll(() => statusText(page)).toBe('V-LINE')
    await page.keyboard.press('Escape')
    await expect.poll(() => statusText(page)).toBe('NORMAL')

    // Leaving Visual is not an idle Escape: the caret must stay in the buffer.
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
    expect(await text(page)).toBe(BODY)
  })

  test('text objects (viw d, ci") and . repeat edit the buffer @p1', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openTextEditor(page, workbench, BODY)
    await setVimEnabled(page, true)
    await expect.poll(() => statusText(page)).toBe('NORMAL')

    await test.step('viwd deletes the word under the cursor', async () => {
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('v')
      await page.keyboard.press('i')
      await page.keyboard.press('w')
      await page.keyboard.press('d')
      await expect.poll(() => text(page)).toBe(' beta\ngamma delta\nepsilon zeta\n')
      await expect.poll(() => statusText(page)).toBe('NORMAL')
    })

    await test.step('ci" changes the text between the quotes and enters Insert', async () => {
      await setText(page, 'say "hello world" now\n')
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 8))
      await page.keyboard.press('c')
      await page.keyboard.press('i')
      await page.keyboard.press('"')
      await expect.poll(() => statusText(page)).toBe('INSERT')
      await expect.poll(() => text(page)).toBe('say "" now\n')
      await page.keyboard.type('X')
      await page.keyboard.press('Escape')
      await expect.poll(() => statusText(page)).toBe('NORMAL')
      await expect.poll(() => text(page)).toBe('say "X" now\n')
    })

    await test.step('. repeats the last change', async () => {
      await setText(page, 'one two three four\n')
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('d')
      await page.keyboard.press('w')
      await expect.poll(() => text(page)).toBe('two three four\n')
      await page.keyboard.press('.')
      await expect.poll(() => text(page)).toBe('three four\n')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })
    })
  })

  test('leader pause opens which-key and Escape closes it @p1', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openTextEditor(page, workbench, BODY)
    await setVimEnabled(page, true)
    await expect.poll(() => statusText(page)).toBe('NORMAL')

    const overlay = page.getByTestId('vim-which-key')
    await page.keyboard.press('Space')
    // The overlay opens after a >300ms pause on the prefix; the retrying
    // assertion waits for it instead of sleeping a fixed time.
    await expect(overlay).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('vim-which-key-prefix')).toContainText('Space')
    expect(await page.getByTestId('vim-which-key-item').count()).toBeGreaterThan(0)

    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await expect.poll(() => feedbackText(page)).toBeUndefined()
    // Cancelling the prefix is not an idle Escape either: focus stays in the editor.
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
    expect(await text(page)).toBe(BODY)
  })

  test('core prefixes open which-key and follow the sequence @p1', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openTextEditor(page, workbench, BODY)
    await setVimEnabled(page, true)
    await expect.poll(() => statusText(page)).toBe('NORMAL')

    const overlay = page.getByTestId('vim-which-key')
    await test.step('g lists the core table and Escape cancels', async () => {
      await page.keyboard.press('g')
      await expect(overlay).toBeVisible({ timeout: 5000 })
      await expect(page.getByTestId('vim-which-key-prefix')).toHaveText('g')
      expect(await page.getByTestId('vim-which-key-item').count()).toBeGreaterThan(10)

      await page.keyboard.press('Escape')
      await expect(overlay).toHaveCount(0)
      await expect.poll(() => feedbackText(page)).toBeUndefined()
      await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
      expect(await text(page)).toBe(BODY)
    })

    await test.step('d then i refreshes the open overlay without waiting again', async () => {
      await page.keyboard.press('d')
      await expect(overlay).toBeVisible({ timeout: 5000 })
      await expect(page.getByTestId('vim-which-key-prefix')).toHaveText('d')
      // No new 300ms delay: an open overlay follows the prefix immediately.
      await page.keyboard.press('i')
      await expect(page.getByTestId('vim-which-key-prefix')).toHaveText('di')
      expect(await page.getByTestId('vim-which-key-item').count()).toBeGreaterThan(10)
      // `diw` changes text; `di` + Escape must only cancel.
      await expect.poll(() => feedbackText(page)).toBe('di')

      await page.keyboard.press('Escape')
      await expect(overlay).toHaveCount(0)
      await expect.poll(() => feedbackText(page)).toBeUndefined()
      await expect.poll(() => statusText(page)).toBe('NORMAL')
      expect(await text(page)).toBe(BODY)
    })
  })

  test('leaving Insert dismisses the suggest widget and which-key yields to it @p1', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openTextEditor(page, workbench, BODY)
    await setVimEnabled(page, true)
    await expect.poll(() => statusText(page)).toBe('NORMAL')
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))

    await test.step('Escape out of Insert closes the visible suggest widget', async () => {
      await page.keyboard.type('i')
      await expect.poll(() => statusText(page)).toBe('INSERT')
      // Monaco's own completion, not a Vim prefix: the command must not be awaited.
      await page.evaluate(() => void window.__E2E__!.runCommand('editor.action.triggerSuggest'))
      await expect.poll(() => workbench.getContextKey<boolean>('suggestWidgetVisible')).toBe(true)

      await page.keyboard.press('Escape')
      await expect.poll(() => statusText(page)).toBe('NORMAL')
      await expect.poll(() => workbench.getContextKey<boolean>('suggestWidgetVisible')).toBe(false)
      expect(await text(page)).toBe(BODY)
    })

    await test.step('a visible suggest widget keeps which-key quiet in Normal', async () => {
      await page.evaluate(() => void window.__E2E__!.runCommand('editor.action.triggerSuggest'))
      await expect.poll(() => workbench.getContextKey<boolean>('suggestWidgetVisible')).toBe(true)

      const overlay = page.getByTestId('vim-which-key')
      await page.keyboard.press('g')
      // The delayed overlay must not appear at all; the pending key still shows.
      await expect.poll(() => feedbackText(page)).toBe('g')
      await expectStableFor(() => overlay.count(), 0, 800)

      await page.keyboard.press('Escape')
      await expect.poll(() => feedbackText(page)).toBeUndefined()
      expect(await text(page)).toBe(BODY)
    })
  })

  test('Show Keymap Cheat Sheet opens a quick pick with the Editor group @p1', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openTextEditor(page, workbench, BODY)
    await setVimEnabled(page, true)
    await expect.poll(() => statusText(page)).toBe('NORMAL')

    // The pick awaits user input, so the command must not be awaited.
    await page.evaluate(
      () => void window.__E2E__!.runCommand('workbench.action.vim.showKeymapCheatSheet'),
    )
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toHaveAttribute('placeholder', /Vim/)
    // The active surface's section comes first; it is the editor here.
    await expect(page.getByTestId('quick-input-separator').first()).toHaveText(
      /^Editor( \(current\))? · /,
    )

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('idle Escape in editor Normal hands focus to the editor tab strip @p1', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openTextEditor(page, workbench, BODY)
    await setVimEnabled(page, true)
    await expect.poll(() => statusText(page)).toBe('NORMAL')
    await expect.poll(() => workbench.getContextKey<string>('vimSurface')).toBe('editor')

    await page.keyboard.press('Escape')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
      .toBe('tab')
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(false)
    await expect.poll(() => workbench.getContextKey<string>('vimSurface')).toBe('tabs')
    expect(await text(page)).toBe(BODY)

    // Enter hands the caret back to the buffer (tabs surface `activate`).
    await page.keyboard.press('Enter')
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
  })

  test('an unmapped Normal key shows Unsupported in the status bar and never types @p1', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openTextEditor(page, workbench, BODY)
    await setVimEnabled(page, true)
    await expect.poll(() => statusText(page)).toBe('NORMAL')
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))

    await page.keyboard.press('Q')
    await expect.poll(() => feedbackText(page)).toBe('Unsupported: Q')
    expect(await text(page)).toBe(BODY)
    expect(await statusText(page)).toBe('NORMAL')

    // The notice is transient (~1.5s) rather than sticking in the status bar.
    await expect.poll(() => feedbackText(page), { timeout: 8000 }).toBeUndefined()
  })
})
