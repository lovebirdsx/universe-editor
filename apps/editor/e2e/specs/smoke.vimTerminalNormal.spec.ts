/*---------------------------------------------------------------------------------------------
 *  Vim Terminal Normal Mode (@p1).
 *
 *  Proves the whole loop against a real pty: entering Normal from the shell,
 *  scrolling the xterm scrollback (j/k, gg/G), linewise `v` selection with `y`
 *  copying into the OS clipboard and returning to Insert, and Esc/i handing the
 *  keyboard back to the shell so typed input reaches the pty again.
 *
 *  Cold-start fixture: the terminal pty (and the xterm holder that owns the
 *  scrollback) lives for the main-process terminal instance, which window reload
 *  cannot reset.
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'
import { setVimEnabled } from '../pages/vimHelpers.js'

const OUTPUT_MARKER = '__E2E_VIM_TERMINAL_OUTPUT__'
const INSERT_MARKER = '__E2E_VIM_TERMINAL_INSERT__'
const CLIPBOARD_SENTINEL = '__E2E_VIM_TERMINAL_SENTINEL__'

/**
 * Absolute buffer line at the top of the xterm viewport, read through the
 * `terminalViewportY` probe. The DOM renderer scrollbar is virtual, so the
 * `.xterm-viewport` `scrollTop` stays 0 regardless of the actual position.
 */
async function viewportY(page: Page, id: string): Promise<number> {
  return page.evaluate((terminalId) => window.__E2E__!.terminalViewportY(terminalId), id)
}

test.describe('@p1 vim terminal normal mode', () => {
  test('scrolls, selects, copies and returns input to the shell', async ({
    page,
    electronApp,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const id = await page.evaluate(() => window.__E2E__!.terminalCreateInWorkspace())
    if (id === null) throw new Error('terminal was not created')

    await workbench.runCommand('workbench.action.terminal.toggleTerminal')
    await workbench.panel.waitForVisible()
    await workbench.panel.waitForActiveTab('workbench.view.terminal')
    await page.locator(`[data-terminal-id="${id}"] .xterm-rows`).waitFor({ state: 'attached' })

    await setVimEnabled(page, true)
    await workbench.runCommand('workbench.action.terminal.focus')
    await expect.poll(() => workbench.getFocusedTerminalId(), { timeout: 10_000 }).toBe(id)
    await expect.poll(() => workbench.getContextKey<boolean>('terminalFocus')).toBe(true)

    // More lines than any panel viewport, so scroll assertions have room.
    const commands = Array.from({ length: 120 }, (_, i) => `echo ${OUTPUT_MARKER}${i}`).join('; ')
    await page.evaluate(
      ([terminalId, command]) => window.__E2E__!.terminalInput(terminalId!, `${command}\r`),
      [id, commands] as const,
    )
    await expect
      .poll(
        () => page.evaluate((terminalId) => window.__E2E__!.terminalReadBuffer(terminalId), id),
        {
          timeout: 15_000,
        },
      )
      .toContain(`${OUTPUT_MARKER}119`)

    const terminalHost = page.locator(`[data-terminal-id="${id}"]`)

    await test.step('Ctrl+Shift+\\ enters Normal mode', async () => {
      await page.keyboard.press('Control+Shift+Backslash')
      await expect.poll(() => workbench.getContextKey<boolean>('vimTerminalNormalMode')).toBe(true)
      await expect(terminalHost).toHaveAttribute('data-vim-normal', 'true')
    })

    await test.step('k scrolls the viewport up, G/gg jump to the edges', async () => {
      // Start from a known bottom position.
      await page.keyboard.press('G')
      await expect.poll(() => viewportY(page, id)).toBeGreaterThan(0)
      const atBottom = await viewportY(page, id)

      await page.keyboard.press('k')
      await expect.poll(() => viewportY(page, id)).toBeLessThan(atBottom)

      await page.keyboard.press('g')
      await page.keyboard.press('g')
      await expect.poll(() => viewportY(page, id)).toBe(0)

      await page.keyboard.press('G')
      await expect.poll(() => viewportY(page, id)).toBeGreaterThan(0)
    })

    await test.step('v + k + y copies the linewise selection and exits Normal', async () => {
      await electronApp.evaluate(
        ({ clipboard }, sentinel) => clipboard.writeText(sentinel),
        CLIPBOARD_SENTINEL,
      )

      // Anchor on the prompt line at the bottom, then extend a few lines up.
      await page.keyboard.press('v')
      await page.keyboard.press('k')
      await page.keyboard.press('k')
      await page.keyboard.press('y')

      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()), {
          timeout: 5000,
        })
        .not.toBe(CLIPBOARD_SENTINEL)
      expect(
        (await electronApp.evaluate(({ clipboard }) => clipboard.readText())).length,
      ).toBeGreaterThan(0)

      await expect.poll(() => workbench.getContextKey<boolean>('vimTerminalNormalMode')).toBe(false)
      await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('insert')
      await expect(terminalHost).not.toHaveAttribute('data-vim-normal', 'true')
    })

    await test.step('i leaves Normal and typed input reaches the shell', async () => {
      await page.keyboard.press('Control+Shift+Backslash')
      await expect.poll(() => workbench.getContextKey<boolean>('vimTerminalNormalMode')).toBe(true)

      await page.keyboard.press('i')
      await expect.poll(() => workbench.getContextKey<boolean>('vimTerminalNormalMode')).toBe(false)

      await page.keyboard.type(`echo ${INSERT_MARKER}`)
      await page.keyboard.press('Enter')
      await expect
        .poll(
          () => page.evaluate((terminalId) => window.__E2E__!.terminalReadBuffer(terminalId), id),
          { timeout: 10_000 },
        )
        .toContain(INSERT_MARKER)
    })
  })
})
