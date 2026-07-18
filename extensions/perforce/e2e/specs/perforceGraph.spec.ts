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
})
