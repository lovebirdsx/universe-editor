/*---------------------------------------------------------------------------------------------
 *  Disposable leak detection smoke test.
 *
 *  Verifies that "Restart Editor" does not leave any un-disposed Disposable
 *  objects behind. The DisposableTracker is installed in both DEV and E2E
 *  modes; on beforeunload it stores a JSON report in sessionStorage. The
 *  probe reads that key after the page reloads.
 *
 *  Tagged @p1 — reports failures but does not block CI.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'
import { DISPOSABLE_LEAK_REPORT_KEY } from '../../src/shared/e2e/contract.js'

test.describe('@p1 disposable leak detection', () => {
  test('Restart Editor leaves no un-disposed Disposables', async ({ workbench }) => {
    await workbench.waitForRestored()

    // Clear any stale report from a previous run so we only see what this restart produces.
    await workbench.page.evaluate(
      (key) => sessionStorage.removeItem(key),
      DISPOSABLE_LEAK_REPORT_KEY,
    )

    // Fire restart and wait for the reloaded page to reach Restored.
    await workbench.waitForRestartRestore()

    // Open a tow editor groups to increase the chance of leaks being detected.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await workbench.runCommand('workbench.action.focusActiveEditorGroup')
    await workbench.runCommand('workbench.action.splitEditorRight')

    // Open the Secondary Sidebar to trigger creation of some more Disposables.
    await workbench.runCommand('workbench.action.toggleSecondarySidebar')

    // Open the Panel to trigger creation of some more Disposables.
    await workbench.runCommand('workbench.action.togglePanel')

    // The beforeunload handler of the old session wrote the leak report (or
    // removed the key if there were no leaks). Read it via the probe.
    const report = await workbench.getLeakReport()

    expect(
      report,
      report
        ? `${report.count} Disposable leak(s) detected after Restart Editor:\n${report.details}`
        : '',
    ).toBeNull()
  })
})
