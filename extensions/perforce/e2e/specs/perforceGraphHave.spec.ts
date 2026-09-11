/*---------------------------------------------------------------------------------------------
 *  Perforce Graph sync badge (@p1) — "where has this workspace got to?".
 *
 *  The row whose changelist is the newest one in the client's have list is
 *  badged, plus a toolbar line naming it, so the graph shows at a glance where
 *  pulled history ends. The probe is `p4 changes -s submitted -m 1 <spec>@<client>`
 *  — the `@client` have-list specifier — which means the fake p4 has to model the
 *  have list, not just hand back a canned change: the seed puts the client on #2
 *  while the depot head is #3, so changelist 4521 (which produced #2) is synced
 *  and 4522 (head, #3) is not.
 *
 *  Two journeys, one cold launch each:
 *
 *  1. The badge lands on 4521 and not on the newer row, and the toolbar names it.
 *  2. Getting the head row moves the badge onto it: the whole chain of a graph
 *     get (sync → cache invalidation → the graph re-reading itself) has to land
 *     before the badge can name the new change. The renderer unit test
 *     (`PerforceGraphEditor re-reads after a get`) is what pins the explicit
 *     revalidate — in this scenario the SCM auto-refresh also delivers a reload,
 *     so a passing e2e here does not by itself prove that path.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { P4SubmittedSeed, SeedFile } from '../fixtures/perforceApp.js'

const V1 = 'v1\n'
const V2 = 'v2\n'
const V3 = 'v3\n'

// The client's have revision is #2 (the depot head is #3) — the middle state a
// long-lived workspace sits in between two gets.
const aTxt: SeedFile = {
  relPath: 'src/a.txt',
  content: V2,
  haveRev: 2,
  haveContent: V2,
  headRev: 3,
  headContent: V3,
  revisions: { '1': V1, '2': V2, '3': V3 },
}

const SUBMITTED: readonly P4SubmittedSeed[] = [
  {
    changelist: '4521',
    user: 'e2e',
    time: '1751600000',
    description: 'a.txt to v2',
    rev: 2,
    files: [{ relPath: 'src/a.txt', action: 'edit', rev: 2 }],
  },
  {
    changelist: '4522',
    user: 'e2e',
    time: '1751600100',
    description: 'a.txt to v3',
    rev: 3,
    files: [{ relPath: 'src/a.txt', action: 'edit', rev: 3 }],
  },
]

async function openGraphWorkspace(
  page: Page,
  workbench: WorkbenchPO,
  openDir: string,
): Promise<void> {
  test.setTimeout(120_000)
  await evaluateWhenRestored(page)
  await workbench.openWorkspace(openDir)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
      timeout: 60_000,
      message: 'perforce extension should register a source control for the workspace',
    })
    .toBeGreaterThan(0)
  await waitForPerforceCommands(workbench)
  await workbench.runCommand('perforce-graph.view')
  const editor = page.locator('[data-testid="perforceGraph-editor"]')
  await expect(editor).toBeVisible()
}

test.describe('@p1 perforce graph sync badge', () => {
  test.use({ p4Seeds: { files: [aTxt], submitted: SUBMITTED } })

  test('badges the newest synced changelist and names it in the toolbar @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()

    await expect(editor.locator('[data-id="4521"]')).toContainText('Synced')
    await expect(editor.locator('[data-id="4522"]')).not.toContainText('Synced')
    await expect(editor).toContainText('Synced to #4521')
  })

  test('moves the badge after getting a newer revision from the graph @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor.locator('[data-id="4521"]')).toContainText('Synced')

    // 4522 is the head row, so this get carries `isLatest` and confirms nothing.
    await editor.locator('[data-id="4522"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get This Revision', { exact: true }).click()

    // Landing on head drops the fake's explicit `haveRev` (back to the plain
    // current-file shape), so the disk content is the observable that moves.
    await expect
      .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
        timeout: 30_000,
        message: 'the get should write head revision #3 to disk',
      })
      .toBe(V3)

    // The badge follows the new have revision without any manual refresh.
    await expect(editor.locator('[data-id="4522"]')).toContainText('Synced')
    await expect(editor.locator('[data-id="4521"]')).not.toContainText('Synced')
    await expect(editor).toContainText('Synced to #4522')
  })
})
