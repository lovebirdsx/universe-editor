/*---------------------------------------------------------------------------------------------
 *  S6 — Toggle panel reveals Output tab (P1).
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p1 output panel', () => {
  test('panel hosts Output tab and toggling round-trips visibility', async ({ workbench }) => {
    // Ensure panel is visible, regardless of starting state (INITIAL_VISIBLE has it on,
    // but storage replay could flip it).
    if (!(await workbench.getContextKey<boolean>('panelVisible'))) {
      await workbench.runCommand('workbench.action.togglePanel')
    }
    await workbench.panel.waitForVisible()
    await expect(workbench.panel.tab('workbench.view.output')).toBeAttached()
    await expect(workbench.panel.tab('workbench.view.output')).toHaveAttribute(
      'aria-selected',
      'true',
    )

    // Toggle off — verifies the command actually drives the layout observable.
    await workbench.runCommand('workbench.action.togglePanel')
    await expect.poll(() => workbench.getContextKey<boolean>('panelVisible')).toBe(false)
  })

  test('first error log reveals Output and activates the emitting channel', async ({
    workbench,
  }) => {
    if (await workbench.getContextKey<boolean>('panelVisible')) {
      await workbench.runCommand('workbench.action.togglePanel')
      await expect.poll(() => workbench.getContextKey<boolean>('panelVisible')).toBe(false)
    }

    await workbench.page.evaluate(() => {
      window.__E2E__!.triggerUnexpectedError('E2E auto reveal error log')
    })

    await expect
      .poll(() => workbench.getContextKey<boolean>('panelVisible'), { timeout: 10_000 })
      .toBe(true)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveOutputChannelName()), {
        timeout: 10_000,
      })
      .toBe('Renderer')
  })
})
