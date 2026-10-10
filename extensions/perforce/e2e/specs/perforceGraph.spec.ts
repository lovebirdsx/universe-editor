/*---------------------------------------------------------------------------------------------
 *  Perforce Graph — opens the read-only submitted-change history editor (P1).
 *
 *  `perforce-graph.view` is a renderer Action2, so it opens the editor tab
 *  regardless of whether a Perforce server is reachable — with no depot the view
 *  simply shows its "unavailable" state. This smoke verifies the command opens
 *  the editor container and the tab survives a reopen (module-level view state).
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/sharedApp.js'

test.describe('@p1 perforce graph', () => {
  test('opens the Perforce Graph editor via command', async ({ page, workbench }) => {
    await workbench.runCommand('perforce-graph.view')

    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor).toBeVisible()
    // The toolbar title renders even before/without any data.
    await expect(editor.getByText('Perforce Graph', { exact: true })).toBeVisible()
  })

  test('opens the sync history page from the toolbar icon', async ({ page, workbench }) => {
    await workbench.runCommand('perforce-graph.view')

    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor).toBeVisible()

    await editor.getByTestId('perforceGraph-openSyncHistory').click()

    // The records live in the extension's own file, so the page renders with or
    // without a workspace — "no extension here" is a state of its own, not a
    // missing page. Refresh is the one control every state has.
    const history = page.getByTestId('perforce-sync-history')
    await expect(history).toBeVisible({ timeout: 30_000 })
    await expect(history.getByTestId('perforce-sync-history-refresh')).toBeVisible()
  })
})
