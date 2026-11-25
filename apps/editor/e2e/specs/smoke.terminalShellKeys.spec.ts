/*---------------------------------------------------------------------------------------------
 *  Ctrl+J / Ctrl+K must reach the shell while the integrated terminal has focus.
 *
 *  Bug: the global keybinding dispatcher swallowed them first — Ctrl+J ran
 *  workbench.action.togglePanel, Ctrl+K started a chord. Both are routed to the
 *  pty as C0 control keys while terminalFocus is true.
 *
 *  冷启 fixture:PTY 属 main 进程状态,且这里要验证真键盘输入仍能到达终端。
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/electronApp.js'

test.describe('@regression terminal shell keys', () => {
  test('Ctrl+J / Ctrl+K reach the shell while workbench keys still fire @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const id = await page.evaluate(() => window.__E2E__!.terminalCreateInWorkspace())
    if (id === null) throw new Error('terminal was not created')

    await workbench.runCommand('workbench.action.terminal.toggleTerminal')
    await workbench.panel.waitForVisible()
    await workbench.panel.waitForActiveTab('workbench.view.terminal')
    await page.locator(`[data-terminal-id="${id}"] .xterm-rows`).waitFor({ state: 'attached' })

    await workbench.runCommand('workbench.action.terminal.focus')
    await expect.poll(() => workbench.getFocusedTerminalId(), { timeout: 10_000 }).toBe(id)
    await expect.poll(() => workbench.getContextKey<boolean>('terminalFocus')).toBe(true)

    // Ctrl+J must not toggle the panel.
    await page.keyboard.press('Control+J')
    await page.waitForTimeout(300)
    expect(await workbench.getContextKey<boolean>('panelVisible')).toBe(true)
    expect(await workbench.getFocusedTerminalId()).toBe(id)

    // Ctrl+K must not enter chord mode.
    await page.keyboard.press('Control+K')
    const entries = await page.evaluate(() => window.__E2E__!.getStatusBarEntries())
    expect(entries.some((entry) => entry.text.includes('Waiting for second key'))).toBe(false)

    // Non-letter shortcuts keep the workbench path inside the terminal.
    await page.keyboard.press('Control+Shift+P')
    await workbench.quickInput.waitForVisible()
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    // The keyboard still reaches the pty after the bypass.
    const marker = '__E2E_TERMINAL_SHELL_KEYS__'
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect
      .poll(() => page.evaluate((tid) => window.__E2E__!.terminalReadBuffer(tid), id), {
        timeout: 10_000,
      })
      .toContain(marker)
  })
})
