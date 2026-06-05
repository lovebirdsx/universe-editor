/*---------------------------------------------------------------------------------------------
 *  Integrated terminal smoke — reveals the terminal panel and proves node-pty
 *  actually spawns + echoes through the cross-process channel in the built app.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'

const MARKER = '__E2E_TERMINAL_OK__'

test.describe('@p0 integrated terminal', () => {
  test('New Terminal reveals the panel with a terminal tab', async ({ workbench }) => {
    await workbench.waitForRestored()
    await workbench.runCommand('workbench.action.terminal.new')

    await workbench.panel.waitForVisible()
    await workbench.panel.waitForActiveTab('workbench.view.terminal')
  })

  test('node-pty spawns and echoes input back', async ({ workbench }) => {
    await workbench.waitForRestored()

    const id = await workbench.page.evaluate(() => window.__E2E__!.terminalCreate())
    await workbench.page.evaluate(
      ([tid]) => window.__E2E__!.terminalInput(tid!, `echo ${'__E2E_TERMINAL_OK__'}\r`),
      [id],
    )

    await expect
      .poll(() => workbench.page.evaluate((tid) => window.__E2E__!.terminalReadBuffer(tid), id), {
        timeout: 10_000,
      })
      .toContain(MARKER)
  })
})

test.describe('@p1 integrated terminal toggle', () => {
  test('toggle hides the terminal when it is already showing', async ({ workbench }) => {
    await workbench.waitForRestored()

    // Force the terminal to be the visible panel container first.
    await workbench.runCommand('workbench.action.terminal.toggleTerminal')
    await workbench.panel.waitForVisible()
    await workbench.panel.waitForActiveTab('workbench.view.terminal')

    // Toggling while the terminal is showing hides the panel.
    await workbench.runCommand('workbench.action.terminal.toggleTerminal')
    await expect.poll(() => workbench.getContextKey<boolean>('panelVisible')).toBe(false)
  })
})
