/*---------------------------------------------------------------------------------------------
 *  Perforce Graph folder-history "Get This Revision" (@p1).
 *
 *  A directory-scoped graph lists the changes that touched anything under the
 *  folder. "Get This Revision" on a non-head row is a directory-level time
 *  travel, so it must ask for the time-travel confirmation before the sync; the
 *  seed makes the sync FORWARD (client has #1, 4521 produced #2 for both files,
 *  4522 produced #3) so it really lands on a middle revision. Assertion is the
 *  dual channel for BOTH files: disk content and the fake depot's haveRev.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands, readHaveRev } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { P4SubmittedSeed, SeedFile } from '../fixtures/perforceApp.js'

const A_V1 = 'a v1\n'
const A_V2 = 'a v2\n'
const A_V3 = 'a v3\n'
const B_V1 = 'b v1\n'
const B_V2 = 'b v2\n'
const B_V3 = 'b v3\n'

const aTxt: SeedFile = {
  relPath: 'src/a.txt',
  content: A_V1,
  headRev: 3,
  headContent: A_V3,
  revisions: { '1': A_V1, '2': A_V2, '3': A_V3 },
}
const bTxt: SeedFile = {
  relPath: 'src/b.txt',
  content: B_V1,
  headRev: 3,
  headContent: B_V3,
  revisions: { '1': B_V1, '2': B_V2, '3': B_V3 },
}

// Both changes touched both files — the folder history lists each change once.
const SUBMITTED: readonly P4SubmittedSeed[] = [
  {
    changelist: '4521',
    user: 'e2e',
    // Unix seconds as a string, matching `p4 -ztag changes` output.
    time: '1751600000',
    description: 'src to v2',
    rev: 2,
    files: [
      { relPath: 'src/a.txt', action: 'edit', rev: 2 },
      { relPath: 'src/b.txt', action: 'edit', rev: 2 },
    ],
  },
  {
    changelist: '4522',
    user: 'e2e',
    time: '1751600100',
    description: 'src to v3',
    rev: 3,
    files: [
      { relPath: 'src/a.txt', action: 'edit', rev: 3 },
      { relPath: 'src/b.txt', action: 'edit', rev: 3 },
    ],
  },
]

test.describe('@p1 perforce graph folder history get revision', () => {
  test.use({ p4Seeds: { files: [aTxt, bTxt], submitted: SUBMITTED } })

  test('a folder-history get asks first and rolls the whole directory to the change @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    // Cold boot + host relaunch on workspace open + the scoped changes query.
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)
    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    await workbench.runCommand('perforce-graph.viewFileHistory', {
      resource: perforce.fileUri('src'),
      isDirectory: true,
    })
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor).toBeVisible()
    // The scoped `changes <dir>/...` query lists only changes touching the folder.
    await expect(editor.locator('[data-id="4522"]')).toBeVisible()
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()

    await editor.locator('[data-id="4521"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get This Revision', { exact: true }).click()

    // Moving a whole directory in time is confirmed before anything syncs.
    const dialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: 'Confirm Sync' }) })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Confirm Sync' }).click()

    for (const [relPath, expected] of [
      ['src/a.txt', A_V2],
      ['src/b.txt', B_V2],
    ] as const) {
      await expect
        .poll(() => readFileSync(perforce.file(relPath), 'utf8'), {
          timeout: 30_000,
          message: `the folder get should write ${relPath} at revision #2`,
        })
        .toBe(expected)
      await expect
        .poll(() => readHaveRev(p4Workspace.stateFile, relPath), {
          timeout: 30_000,
          message: `the fake depot should report haveRev 2 for ${relPath}`,
        })
        .toBe(2)
    }
  })
})
