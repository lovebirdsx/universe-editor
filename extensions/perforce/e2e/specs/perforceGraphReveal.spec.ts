/*---------------------------------------------------------------------------------------------
 *  Perforce Graph reveal bridge (@p1).
 *
 *  `_workbench.openPerforceGraph <cl>` (the bridge timeline items and blame
 *  links call) must open the Perforce Graph editor, select the changelist row
 *  and scroll it into view. Seeded history comes from the fake p4 (the
 *  annotate seed doubles as the graph's submitted-changes source), so these
 *  specs use the cold-launch perforce fixture rather than the shared instance.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'

const REVEAL_SEEDS = {
  files: [{ relPath: 'tracked.txt', content: 'original content\n' }],
  annotate: {
    changelist: '4521',
    user: 'e2e',
    time: '1751600000',
    description: 'seeded submitted change',
  },
} as const

test.describe('@p1 perforce graph reveal', () => {
  test.use({ p4Seeds: REVEAL_SEEDS })

  async function openSeededWorkspace(
    page: Parameters<typeof evaluateWhenRestored>[0],
    workbench: { openWorkspace(dir: string): Promise<unknown> },
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
  }

  test('reveals a seeded changelist via the _workbench bridge', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openSeededWorkspace(page, workbench, perforce.openDir)

    await workbench.runCommand('_workbench.openPerforceGraph', '4521')

    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor).toBeVisible()
    const row = editor.locator('[data-id="4521"]')
    await expect(row).toBeVisible()
    // Selection shows in the row class (the CSS module keeps its local name).
    // Change details now live in the Commit Changes sidebar view (covered by
    // perforceViewCommit.spec.ts); the graph no longer has a bottom panel.
    await expect(row).toHaveClass(/rowSelected/)
  })

  test('timeline open-in-graph command drives the same reveal end to end', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openSeededWorkspace(page, workbench, perforce.openDir)

    // The extension-side timeline command takes the timeline item and forwards
    // its changelist id to the renderer bridge.
    await workbench.runCommand('perforce.timeline.openInGraph', { id: '4521' })

    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor).toBeVisible()
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()
  })
})
