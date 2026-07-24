/*---------------------------------------------------------------------------------------------
 *  Terminal profile detection smoke — the new-terminal chevron menu is fed by
 *  main-side detection (VSCode-style). Asserts platform invariants that must
 *  hold on any CI runner: Windows always offers the PowerShell family + cmd;
 *  Linux parses /etc/shells into at least one entry.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p1 terminal profiles', () => {
  test('detects platform shell profiles', async ({ workbench }) => {
    await workbench.waitForRestored()

    await expect
      .poll(
        async () =>
          (await workbench.page.evaluate(() => window.__E2E__!.terminalProfiles())).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0)

    const names = await workbench.page.evaluate(() => window.__E2E__!.terminalProfiles())
    if (process.platform === 'win32') {
      expect(names).toContain('PowerShell')
      expect(names).toContain('Command Prompt')
    }
  })
})
