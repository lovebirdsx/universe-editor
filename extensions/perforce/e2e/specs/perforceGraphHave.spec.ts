/*---------------------------------------------------------------------------------------------
 *  Perforce Graph sync point (@p1) — "where has this workspace got to?".
 *
 *  The row whose changelist is the newest one this workspace has pulled is
 *  badged, plus a toolbar line naming it. The answer comes from the extension's
 *  local sync ledger, which every get run through the editor writes; the server
 *  probe (`p4 changes -s submitted -m 1 <spec>#have` — the `#have` revision
 *  specifier) is now the EXCEPTION, because its cost is the size of the scope:
 *  ~40s over a million-file workspace, re-paid on every load before this.
 *
 *  What that means for the fake p4: `#have` still has to model the have list
 *  (the seed puts the client on #2 while the depot head is #3, so 4521 produced
 *  #2 and is synced while 4522 produced #3 and is not), and the post-sync
 *  read-back (`<scope>@<cl>`, taken right after a get so the recorded changelist
 *  is measured rather than assumed) has to narrow by changelist.
 *
 *  The answer arrives after the listing is already on screen (a second command,
 *  and on the ledger path a synchronous one), which is why every assertion below
 *  is on the badge / the toolbar line rather than on a loaded list.
 *
 *  Five journeys, one cold launch each:
 *
 *  1. Opening the graph asks NOTHING: the whole-graph scope is too wide to probe
 *     on open, so the line says `#? (click to query)` until the query button is
 *     pressed. Clicking the resulting `#4521` then reveals that row — as does
 *     the row menu's own `Go to Sync Point`, from any row.
 *  2. Getting the head row moves the badge onto it with no query at all — the
 *     ledger read is the only thing that could have answered, since the
 *     whole-graph scope never probes on its own. The renderer unit test
 *     (`PerforceGraphEditor re-reads after a get`) is what pins the explicit
 *     revalidate — in this scenario the SCM auto-refresh may also deliver a
 *     reload, so a passing e2e here does not by itself prove that path.
 *  2b. The same get on an ALREADY current workspace applies nothing (`file(s)
 *     up-to-date.`) and must still be recorded — the branch that a "nothing
 *     happened, so record nothing" rule would have silently dropped.
 *  3. The opened folder is a SUBDIRECTORY of the client, and the two scopes
 *     genuinely disagree (a file outside the folder is synced further along).
 *     The folder's answer (4521) must NOT be reused once the scope widens to the
 *     whole repository — the ledger only answers a scope from a record that
 *     CONTAINS it, so the widened scope goes back to "not known" and its own
 *     query answers 4522. That widened probe lists `//...`, which cannot carry a
 *     revision specifier at all (`Path 'E:/...' is not under client's root`), so
 *     it asks the client root's wildcard instead — the one branch that had never
 *     answered against a real server.
 *  4. The same containment read the other way, and the case a user hit against a
 *     real depot: the record is WIDER than the tab, and the changelist it names
 *     touched nothing under the tab's scope. That folder's history cannot contain
 *     the row, so jumping to the point has to land on the newest change the sync
 *     covers rather than paging the whole history in looking for it. The folder
 *     then queries its OWN point — a LOWER changelist, because the wide one never
 *     touched it — and that must not retire the client's answer: a read-only query
 *     moves no file, and losing the client's entry would put `#? (click to query)`
 *     back in front of the user, one whole-client probe later.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { P4SubmittedSeed, SeedFile } from '../fixtures/perforceApp.js'

const V1 = 'v1\n'
const V2 = 'v2\n'
const V3 = 'v3\n'

const UNKNOWN = '#? (click to query)'

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

test.describe('@p1 perforce graph sync point', () => {
  test.use({ p4Seeds: { files: [aTxt], submitted: SUBMITTED } })

  test('stays unknown on open, answers the query button, and jumps to the row @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()

    // Nothing recorded for this workspace and nothing asked: opening the graph
    // must not pay a whole-workspace `#have` probe, so the line says so instead.
    await expect(line).toHaveText(UNKNOWN)
    await expect(editor.locator('[data-id="4521"]')).not.toContainText('Synced')
    await expect(editor.locator('[data-id="4522"]')).not.toContainText('Synced')

    // The query button belongs to the answer, so it sits on the summary line and
    // not in the row of view controls at the right (`..` is the count span).
    await expect(line.locator('..').getByTestId('perforceGraph-querySyncPoint')).toBeVisible()

    await editor.getByTestId('perforceGraph-querySyncPoint').click()
    await expect(line).toHaveText('#4521')
    // Provenance is user-visible: a queried answer is the server's, as of now.
    await expect(line).toHaveAttribute('data-tooltip', /Answered by Perforce at/)
    await expect(editor.locator('[data-id="4521"]')).toContainText('Synced')
    await expect(editor.locator('[data-id="4522"]')).not.toContainText('Synced')

    // Clicking the line jumps to that row: a filter that hides it is cleared,
    // which only the reveal path does.
    await editor.getByLabel('Search changes…').fill('4522')
    await expect(editor.locator('[data-id="4521"]')).not.toBeVisible()
    await line.click()
    await expect(editor.getByLabel('Search changes…')).toHaveValue('')
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()

    // The row menu carries both actions as well — the graph is drivable from
    // where the mouse already is (on any row, not just the badged one).
    await editor.getByLabel('Search changes…').fill('4522')
    await expect(editor.locator('[data-id="4521"]')).not.toBeVisible()
    await editor.locator('[data-id="4522"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await expect(menu.getByText('Query Sync Point', { exact: true })).toBeVisible()
    await menu.getByText('Go to Sync Point', { exact: true }).click()
    await expect(editor.getByLabel('Search changes…')).toHaveValue('')
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()
  })

  test('moves the badge after getting a newer revision, with no query at all @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(line).toHaveText(UNKNOWN)

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

    // The badge follows the recorded get without any manual refresh — and could
    // not have come from the server, which this scope never asks on its own.
    await expect(line).toHaveText('#4522')
    await expect(line).toHaveAttribute('data-tooltip', /Recorded at/)
    await expect(editor.locator('[data-id="4522"]')).toContainText('Synced')
    await expect(editor.locator('[data-id="4521"]')).not.toContainText('Synced')
  })
})

// A workspace that is already current: the file sits at head (#3, explicitly, so
// the get below has nothing to move), so 4522 added it and nothing is left to pull.
const atHead: SeedFile = {
  relPath: 'src/a.txt',
  content: V3,
  headRev: 3,
  headContent: V3,
  haveRev: 3,
  haveContent: V3,
  revisions: { '1': V1, '2': V2, '3': V3 },
}

test.describe('@p1 perforce graph sync point, workspace already current', () => {
  test.use({ p4Seeds: { files: [atHead], submitted: SUBMITTED } })

  test('records a get that p4 answers "up to date" @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(line).toHaveText(UNKNOWN)

    // This get lands on nothing (`file(s) up-to-date.`, exit 0) — but "there was
    // nothing to do" is an answer, not a gap: it says the scope really is at
    // 4522. Skipping the record here leaves this user with a badge that says
    // "click to query" right after a toast told them they were already current.
    await editor.locator('[data-id="4522"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get This Revision', { exact: true }).click()

    await expect(line).toHaveText('#4522')
    await expect(line).toHaveAttribute('data-tooltip', /Recorded at/)
    await expect(editor.locator('[data-id="4522"]')).toContainText('Synced')
  })
})

// The shape journey 3 needs: the opened folder is a SUBDIRECTORY of the client,
// and the client-wide sync point comes from a file outside it. `other/b.txt` is
// plain (head == have == #1) and 4522 is the change that added it, so the two
// scopes genuinely disagree about where pulled history ends.
const SPLIT_SUBMITTED: readonly P4SubmittedSeed[] = [
  SUBMITTED[0]!,
  {
    ...SUBMITTED[1]!,
    files: [...SUBMITTED[1]!.files, { relPath: 'other/b.txt', action: 'add' as const, rev: 1 }],
  },
]

test.describe('@p1 perforce graph sync point, folder inside a wider client', () => {
  test.use({
    p4Seeds: { files: [aTxt, { relPath: 'other/b.txt', content: 'b1\n' }], submitted: SPLIT_SUBMITTED },
    openSubdir: 'src',
  })

  test('answers each scope from its own query @regression', async ({ page, workbench, perforce }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()
    await expect(line).toHaveText(UNKNOWN)

    // The opened folder's probe only sees `src/a.txt`, which is synced at #2.
    await editor.getByTestId('perforceGraph-querySyncPoint').click()
    await expect(line).toHaveText('#4521')
    await expect(editor.locator('[data-id="4522"]')).not.toContainText('Synced')

    // Widening to the whole client changes the ANSWER, not just the listing:
    // `other/b.txt` IS synced at 4522, and the widened probe asks the client
    // root's wildcard (//... takes no revision specifier at all). The folder's
    // 4521 must not survive the switch — it describes a narrower scope, and
    // reusing it is exactly the over-report that must not happen.
    const scopeToggle = editor.getByLabel('Toggle repository scope')
    await scopeToggle.click()
    await expect(scopeToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(line).toHaveText(UNKNOWN)

    await editor.getByTestId('perforceGraph-querySyncPoint').click()
    await expect(line).toHaveText('#4522')
    await expect(editor.locator('[data-id="4522"]')).toContainText('Synced')
    await expect(editor.locator('[data-id="4521"]')).not.toContainText('Synced')
  })
})

// The shape journey 4 needs: `src/a.txt` is current at #3 while `other/c.txt`
// (added by 4523) is the whole client's newest pulled changelist — so a
// whole-client query answers a changelist the folder's own history never
// contains. Every file is current, which is what makes that the answer.
const currentA: SeedFile = {
  relPath: 'src/a.txt',
  content: V3,
  headRev: 3,
  headContent: V3,
  haveRev: 3,
  haveContent: V3,
  revisions: { '1': V1, '2': V2, '3': V3 },
}

const WIDER_SUBMITTED: readonly P4SubmittedSeed[] = [
  SUBMITTED[0]!,
  SUBMITTED[1]!,
  {
    changelist: '4523',
    user: 'e2e',
    time: '1751600200',
    description: 'c.txt outside the folder',
    rev: 1,
    files: [{ relPath: 'other/c.txt', action: 'add', rev: 1 }],
  },
]

test.describe('@p1 perforce graph sync point, folder whose history the point never touched', () => {
  test.use({
    p4Seeds: { files: [currentA, { relPath: 'other/c.txt', content: 'c1\n' }], submitted: WIDER_SUBMITTED },
    openSubdir: 'src',
  })

  test('lands on the newest change the sync covers @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()

    // The whole client is current, so its query answers 4523 — a changelist that
    // touched nothing under the opened folder.
    const scopeToggle = editor.getByLabel('Toggle repository scope')
    await scopeToggle.click()
    await expect(scopeToggle).toHaveAttribute('aria-pressed', 'true')
    await editor.getByTestId('perforceGraph-querySyncPoint').click()
    await expect(line).toHaveText('#4523')

    // Back to the folder, whose history is 4522/4521: no 4523 row here, and
    // there never will be. The wider record still answers (as an upper bound), so
    // the badge lands on the newest change the sync does cover — and not on a row
    // that does not exist.
    await scopeToggle.click()
    await expect(scopeToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(editor.locator('[data-id="4522"]')).toBeVisible()
    await expect(line).toHaveText('#4523')
    await expect(line).toHaveAttribute('data-tooltip', /wider scope/)
    await expect(editor.locator('[data-id="4522"]')).toContainText('Synced')
    await expect(editor.locator('[data-id="4521"]')).not.toContainText('Synced')

    // Jumping to it must land somewhere. The filter is the observable that the
    // reveal ran (it clears one), and the toast is what says the point itself has
    // no row here: paging for it would pull the folder's whole history in and
    // still come up empty.
    await editor.getByLabel('Search changes…').fill('4521')
    await expect(editor.locator('[data-id="4522"]')).not.toBeVisible()
    await line.click()
    await expect(editor.getByLabel('Search changes…')).toHaveValue('')
    await expect(editor.locator('[data-id="4522"]')).toBeVisible()
    await expect(editor.locator('[data-id="4522"]')).toContainText('Synced')
    const toast = page.locator('[data-testid="notification-toast-item"]')
    await expect(toast).toContainText('4523')
    await expect(toast).toContainText('4522')

    // The containment rule read the other way, and the shape a user hit against a
    // real depot: the folder queries its OWN sync point and gets 4522 — LOWER than
    // the client's 4523, because 4523 never touched this folder and `#have` names
    // the newest changelist that did. A lower number is not a contradiction, and a
    // read-only query moves no file, so the client's entry has to survive it:
    // switching back must still answer 4523, not drop to `#? (click to query)`.
    await editor.getByTestId('perforceGraph-querySyncPoint').click()
    await expect(line).toHaveText('#4522')
    await scopeToggle.click()
    await expect(scopeToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(line).toHaveText('#4523')
  })
})
