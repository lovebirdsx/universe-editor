/*---------------------------------------------------------------------------------------------
 *  Perforce Graph "Get Revision" (@p1).
 *
 *  Whole-repo graph rows offer two P4V-style time-travel entries: "Get This
 *  Revision" (sync the displayed range onto the row's changelist) and "Get
 *  Revision…" (pick top-level client directories in a dialog first). The seeds
 *  make every sync FORWARD — the client has #1, changelist 4521 produced #2 and
 *  4522 (head) produced #3, so `p4 sync @<cl>` lands on a real middle revision
 *  (a backward sync without `-f` is a no-op on the fake, mirroring a clobbering
 *  client's plain get). Three forward-get journeys, one cold launch each:
 *
 *  1. A non-head row's get asks for the time-travel confirmation first, and the
 *     Confirm Sync button really lands the workspace on #2 (disk + have rev).
 *  2. The head row's get is a get-latest equivalent: no dialog can park it — the
 *     disk poll to #3 is itself the guard (a parked confirm would time it out).
 *  3. "Get Revision…" lists the client's top-level directories (`src`) and
 *     syncing the picked one lands the same @4521 state, dialog-confirmed.
 *
 *  A fourth block below covers the force entry (`p4 sync -f`) with a `refused`
 *  seed, where the bytes on disk are what distinguish a real force from a no-op.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands, readHaveRev } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Locator, Page } from '@playwright/test'
import type { P4SubmittedSeed, SeedFile } from '../fixtures/perforceApp.js'

const V1 = 'v1\n'
const V2 = 'v2\n'
const V3 = 'v3\n'

// The client has #1; the depot head is #3. `sync @4521` must land on #2.
const aTxt: SeedFile = {
  relPath: 'src/a.txt',
  content: V1,
  headRev: 3,
  headContent: V3,
  revisions: { '1': V1, '2': V2, '3': V3 },
}

const SUBMITTED: readonly P4SubmittedSeed[] = [
  {
    changelist: '4521',
    user: 'e2e',
    // Unix seconds as a string, matching `p4 -ztag changes` output.
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
  // Cold boot + host relaunch on workspace open + the graph's changes query.
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

test.describe('@p1 perforce graph get revision', () => {
  test.use({ p4Seeds: { files: [aTxt], submitted: SUBMITTED } })

  const confirmDialog = (page: Page) =>
    page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Confirm Sync' }) })

  test('a non-head row get confirms first, then lands the workspace on that change @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()

    await editor.locator('[data-id="4521"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get This Revision', { exact: true }).click()

    // Moving a whole displayed range in time is destructive enough to ask first.
    const dialog = confirmDialog(page)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Confirm Sync' }).click()

    await expect
      .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
        timeout: 30_000,
        message: 'the confirmed get should write revision #2 to disk',
      })
      .toBe(V2)
    await expect
      .poll(() => readHaveRev(p4Workspace.stateFile, 'src/a.txt'), {
        timeout: 30_000,
        message: 'the fake depot should report haveRev 2 for the file',
      })
      .toBe(2)
  })

  test('the head row get skips the confirmation and lands head @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor.locator('[data-id="4522"]')).toBeVisible()

    await editor.locator('[data-id="4522"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get This Revision', { exact: true }).click()

    // isLatest: a get-latest equivalent, so no dialog may park the sync — if one
    // did, the poll below would time out on the untouched have revision.
    await expect
      .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
        timeout: 30_000,
        message: 'the head-row get must land #3 without waiting on a confirmation',
      })
      .toBe(V3)
  })

  test('Get Revision… lists the top-level directories and syncs the picked one @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()

    await editor.locator('[data-id="4521"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get Revision…', { exact: true }).click()

    const dialog = page.getByTestId('perforceGraph-syncDialog')
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    // The client root's only top-level directory is the seeded `src`.
    await expect(dialog.getByText('src', { exact: true })).toBeVisible()
    // All candidates start selected, so the confirm names one folder.
    await dialog.getByRole('button', { name: 'Get Revision (1)' }).click()

    await expect
      .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
        timeout: 30_000,
        message: 'the dialog-confirmed get should write revision #2 to disk',
      })
      .toBe(V2)
    await expect
      .poll(() => readHaveRev(p4Workspace.stateFile, 'src/a.txt'), {
        timeout: 30_000,
        message: 'the fake depot should report haveRev 2 for the file',
      })
      .toBe(2)
  })
})

/*---------------------------------------------------------------------------------------------
 *  Force get (`p4 sync -f`) from the same menu. The seed is the crux: `refused`
 *  makes the fake skip the file with `can't update modified file` (an `allwrite
 *  noclobber` client) and keep the local copy, exactly as a plain get would —
 *  so the bytes on disk distinguish a real `-f` from a no-op, which a forward
 *  get could never do (both write the same revision either way).
 *
 *  Two journeys: a refused file is overwritten only after the confirmation, and
 *  the newest row — the one whose plain get carries `isLatest` — still confirms.
 *--------------------------------------------------------------------------------------------*/

test.describe('@p1 perforce graph force get', () => {
  const aTxtRefused: SeedFile = { ...aTxt, refused: true }
  test.use({ p4Seeds: { files: [aTxtRefused], submitted: SUBMITTED } })

  const forceDialog = (page: Page) =>
    page.getByRole('dialog').filter({
      has: page.getByRole('button', { name: 'Force Get', exact: true }),
    })

  /** Right-click `rowId` and take the force entry, returning the parked dialog. */
  async function clickForceGet(page: Page, rowId: string): Promise<Locator> {
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor.locator(`[data-id="${rowId}"]`)).toBeVisible()

    await editor.locator(`[data-id="${rowId}"]`).click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Force Get (Overwrite Local Files)', { exact: true }).click()

    const dialog = forceDialog(page)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    return dialog
  }

  test('overwrites a refused file only after the force confirmation @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    // The uncollected work the dialog warns about. `refused` is what makes p4
    // skip this file on a plain get, so these bytes survive unless `-f` runs.
    const draft = 'local draft\n'
    writeFileSync(perforce.file('src/a.txt'), draft, 'utf8')

    const dialog = await clickForceGet(page, '4521')
    await expect(dialog).toContainText('uncollected changes')
    // Both facts the dialog exists to deliver: where it travels to, and how wide.
    await expect(dialog).toContainText('@4521')
    // One merged dialog — the time-travel prompt must not be stacked under it.
    await expect(page.getByRole('button', { name: 'Confirm Sync' })).toHaveCount(0)
    // Nothing has been written while the confirmation is still up.
    expect(readFileSync(perforce.file('src/a.txt'), 'utf8')).toBe(draft)

    await dialog.getByRole('button', { name: 'Force Get', exact: true }).click()

    await expect
      .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
        timeout: 30_000,
        message: 'the forced get should overwrite the local draft with revision #2',
      })
      .toBe(V2)
    await expect
      .poll(() => readHaveRev(p4Workspace.stateFile, 'src/a.txt'), {
        timeout: 30_000,
        message: 'a force get over a refused file advances the have revision',
      })
      .toBe(2)
  })

  test('the newest row still confirms — force has no get-latest waiver @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const dialog = await clickForceGet(page, '4522')

    // Mirror image of "the head row get skips the confirmation" above: on the
    // same row, the force entry must still park. Without this, the newest row
    // would be a silent path to destroying uncollected local work.
    await expect(dialog).toContainText('@4522')
    await dialog.getByRole('button', { name: 'Force Get', exact: true }).click()

    await expect
      .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
        timeout: 30_000,
        message: 'the confirmed force get must land #3 on the newest row',
      })
      .toBe(V3)
  })
})
