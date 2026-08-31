/*---------------------------------------------------------------------------------------------
 *  Perforce Graph scoped file history (@p1).
 *
 *  `perforce-graph.viewFileHistory <resource>` (a renderer Action2) opens a
 *  Perforce Graph editor whose history is scoped to a single file: the in-editor
 *  header and the tab title both read `History: <basename>`, and the seeded
 *  submitted change loads through the fake p4 (the annotate seed doubles as the
 *  graph's submitted-changes source, same as perforceGraphReveal.spec.ts). Uses
 *  the cold-launch fixture so the seeded depot backs the scoped `getChanges`.
 *--------------------------------------------------------------------------------------------*/

import { expect, test, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'

const HISTORY_SEEDS = {
  files: [{ relPath: 'tracked.txt', content: 'original content\n' }],
  annotate: {
    changelist: '4521',
    user: 'e2e',
    time: '1751600000',
    description: 'seeded submitted change',
  },
} as const

test.describe('@p1 perforce graph file history', () => {
  test.use({ p4Seeds: HISTORY_SEEDS })

  async function openSeededWorkspace(
    page: Parameters<typeof evaluateWhenRestored>[0],
    workbench: WorkbenchPO,
    openDir: string,
  ): Promise<void> {
    // Cold boot + host relaunch on workspace open; give headroom like the other
    // extension-host smokes.
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)
    await workbench.openWorkspace(openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    // The SCM-count gate flips before the contributed command handlers register
    // (same activate(), later burst) — the scoped getChanges would resolve to no
    // handler and the editor would stick on "unavailable" with no retry.
    await waitForPerforceCommands(workbench)
  }

  test('opens a file-scoped history tab via the command', async ({ page, workbench, perforce }) => {
    await openSeededWorkspace(page, workbench, perforce.openDir)

    // `perforce.file()` is a forward-slashed host path; the Action2 revives the
    // arg through URI.revive, so hand it the file scheme's leading-slash path.
    await workbench.runCommand('perforce-graph.viewFileHistory', {
      resource: { scheme: 'file', path: '/' + perforce.file('tracked.txt') },
      isDirectory: false,
    })

    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor).toBeVisible()
    // In-editor header and the tab title both carry the file's basename.
    await expect(editor.getByText('History: tracked.txt', { exact: true })).toBeVisible()
    await expect(page.getByRole('tab').filter({ hasText: 'tracked.txt' })).toBeVisible()
    // The scoped `getChanges` round-trips through the fake p4 and loads the
    // seeded submitted change (not just the "unavailable" placeholder).
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()
  })
})
