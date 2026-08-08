/*---------------------------------------------------------------------------------------------
 *  Perforce "Open Commit" smoke test (@p1).
 *
 *  `perforce.viewCommit <uri> <changelist>` (the timeline/blame entry point)
 *  must surface the sidebar "Commit Changes" view with the changelist's title
 *  and one file row per file the change touched; clicking a file row opens
 *  that file's diff editor. Seeded history comes from the fake p4 (the
 *  submitted seed doubles as `describe -s` + `changes -l` source), so these
 *  specs use the cold-launch perforce fixture rather than the shared instance.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { SeedFile } from '../fixtures/perforceApp.js'

const trackedA: SeedFile = { relPath: 'a.txt', content: 'a v1\na v2\n' }
const trackedB: SeedFile = { relPath: 'b.txt', content: 'b v1\n' }

const SUBMITTED = {
  changelist: '7001',
  user: 'e2e',
  // Unix seconds as a string, matching `p4 -ztag changes` output.
  time: '1748000000',
  description: 'touch a and b',
  files: [
    // rev 1 edits diff against an empty left side (base = rev-1 → none), so the
    // diff content is non-trivial without seeding a full revision history.
    { relPath: 'a.txt', action: 'edit' as const, rev: 1 },
    { relPath: 'b.txt', action: 'edit' as const, rev: 1 },
  ],
}

test.use({
  p4Seeds: { files: [trackedA, trackedB], submitted: SUBMITTED },
})

test.describe('@p1 perforce view commit', () => {
  test('perforce.viewCommit surfaces the Commit Changes view with one row per changed file', async ({
    page,
    workbench,
    perforce,
  }) => {
    // Cold boot + host relaunch on workspace open + describe round-trip.
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)

    await workbench.runCommand(
      'perforce.viewCommit',
      `file:///${perforce.file(trackedA.relPath)}`,
      SUBMITTED.changelist,
    )

    const view = page.locator('[data-testid="commitChanges-view"]')
    await expect(view).toBeVisible({ timeout: 30_000 })
    // The SCM container must be activated in the SideBar (location 0) —
    // probe-based, Allotment.Pane CSS visibility would misjudge DOM.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveViewContainerId(0)), {
        message: 'the SCM container should be the active sidebar container',
      })
      .toBe('workbench.view.scm')

    // Title carries the changelist number; the change touched two files.
    await expect(view.locator('[data-testid="commitChanges-title"]')).toContainText(
      `Changelist ${SUBMITTED.changelist}`,
    )
    await expect(view.locator('[data-row-key^="file:"]')).toHaveCount(2)

    // Clicking a file row opens that file's diff editor. Row paths are the
    // depot path minus the leading `//` (e.g. `depot/a.txt`), so match the
    // `a.txt` row by suffix rather than guessing the depot root.
    await view.locator('[data-row-key$="a.txt"]').first().click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 30_000,
        message: 'clicking a file row should open the diff editor',
      })
      .toBe('diff')
  })
})
