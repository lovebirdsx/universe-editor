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
 *  Nine journeys, one cold launch each:
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
 *  5. A get whose own read-back outlives the 5s window it is given, which on a
 *     real workspace is every scope wider than a file. The entry lands late, on
 *     its own, and the badge moves with no user action — see the block comment
 *     above that describe.
 *  6. The same row get, but with a fake that would take 40s to answer a
 *     read-back and a log of every read-back it was asked: the badge still moves
 *     and the log stays EMPTY. Journeys 2/2b pass on a fast fake whatever the
 *     extension does, so this is the one that holds the shortcut (a row's
 *     changelist written down without asking) in place.
 *  7. The counter-example the shortcut must never widen into: the same row get
 *     started from the scope dialog, whose picked directories are NARROWER than
 *     the listing. It falls back to the read-back and the recorded answer is
 *     p4's (4521), not the clicked row (4522) — so a tab scoped to the get's own
 *     scope badges 4521. 4521 and 4522 touch different directories precisely so
 *     the two candidate answers differ.
 *  8. The listing the shortcut deliberately does not cover: the whole-repo one
 *     (`//...`, the globe toggle). Its rows answer in depot coordinates while
 *     the ledger's are host paths under the client root, so the coverage test
 *     would compare the client root with itself and prove nothing — that get
 *     keeps paying a read-back. The badge moves either way here (the clicked row
 *     IS the read-back's answer for `//...`), so the log is the evidence again.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '@universe-editor/temp-root'
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
    p4Seeds: {
      files: [aTxt, { relPath: 'other/b.txt', content: 'b1\n' }],
      submitted: SPLIT_SUBMITTED,
    },
    openSubdir: 'src',
  })

  test('answers each scope from its own query @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
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
    p4Seeds: {
      files: [currentA, { relPath: 'other/c.txt', content: 'c1\n' }],
      submitted: WIDER_SUBMITTED,
    },
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

// The real-machine report this last journey exists for: against a real server a
// get's read-back costs the scope's WIDTH — 0.2s for one file, but 12.8s for a
// mid subtree and 27.3s for a workspace root — and the awaited attempt is given
// 5s so that a wide get does not stall behind its own bookkeeping. Every get
// wider than a file therefore lost its entry SILENTLY: the sync landed, nothing
// was recorded, and the graph kept answering with an older query's changelist.
// The answer now arrives late, from a background retry, and the entry pokes the
// renderer so the badge moves with no user action at all.
//
// The fake answers instantly by default, so this is the one shape the rest of
// the suite cannot reach: `UNIVERSE_P4_FAKE_READBACK_MS` holds the read-back
// open instead of modelling width.
test.describe('@p1 perforce graph sync point, read-back slower than the get', () => {
  test.use({
    p4Seeds: { files: [aTxt], submitted: SUBMITTED },
    p4ExtraEnv: { UNIVERSE_P4_FAKE_READBACK_MS: '7000' },
  })

  test('moves the badge by itself once the late read-back lands @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(line).toHaveText(UNKNOWN)

    await editor.locator('[data-id="4522"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get This Revision', { exact: true }).click()

    await expect
      .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
        timeout: 30_000,
        message: 'the get should write head revision #3 to disk',
      })
      .toBe(V3)

    // The get is over and the badge is STILL unknown — which is the whole point
    // of the delay: the read-back that would answer it was killed by its own 5s
    // window and is being asked again in the background. If this line already
    // read `#4522` the journey would be passing without ever reaching the path
    // it is here to guard.
    await expect(line).toHaveText(UNKNOWN)

    // Nothing is clicked, queried or reloaded from here on: the late entry lands
    // on its own, and the graph re-derives the badge from it (the entry pokes the
    // SCM observables, which is the only channel it has into the renderer).
    await expect(line).toHaveText('#4522', { timeout: 60_000 })
    await expect(line).toHaveAttribute('data-tooltip', /Recorded at/)
    await expect(editor.locator('[data-id="4522"]')).toContainText('Synced')
    await expect(editor.locator('[data-id="4521"]')).not.toContainText('Synced')
  })
})

/** The lines fake-p4 appended to `UNIVERSE_P4_FAKE_READBACK_LOG`, if any: one
 *  per `changes` call carrying a revision suffix, i.e. one per honest attempt to
 *  ask the server where a get landed. */
function readbackLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
  } catch {
    return []
  }
}

// A read-back the fake could not answer inside any test's patience. The ledger
// entry a row's get writes needs no server round-trip at all, so this delay
// never elapses — and if the extension ever goes back to asking, the badge
// cannot move in time for the assertion below, on top of the log check.
const ZERO_READBACK_LOG = join(mkTempDir('p4-readback-none-'), 'readback.log')

test.describe('@p1 perforce graph sync point, a row get never asks the server', () => {
  test.use({
    p4Seeds: { files: [aTxt], submitted: SUBMITTED },
    p4ExtraEnv: {
      UNIVERSE_P4_FAKE_READBACK_MS: '40000',
      UNIVERSE_P4_FAKE_READBACK_LOG: ZERO_READBACK_LOG,
    },
  })

  test('records the row changelist with no read-back at all @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(line).toHaveText(UNKNOWN)

    await editor.locator('[data-id="4522"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get This Revision', { exact: true }).click()

    await expect
      .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
        timeout: 30_000,
        message: 'the get should write head revision #3 to disk',
      })
      .toBe(V3)
    await expect(line).toHaveText('#4522')
    await expect(line).toHaveAttribute('data-tooltip', /Recorded at/)

    // The hard evidence, and the reason this journey exists: the badge moving
    // proves nothing on a fake that answers instantly — an implementation that
    // asks and then ignores the answer passes that half just as well. A
    // read-back log that is still EMPTY is what only the real behaviour
    // satisfies (the fake appends to it before it would have waited).
    expect(readbackLines(ZERO_READBACK_LOG)).toEqual([])
  })
})

// Two changes that touched DIFFERENT directories, so "which changelist did this
// get land on?" has two candidate answers that can be told apart: 4521 (what a
// read-back answers for `src`) and 4522 (the row the user clicked, which never
// touched `src`).
const srcA: SeedFile = {
  relPath: 'src/a.txt',
  content: V1,
  haveRev: 1,
  haveContent: V1,
  headRev: 2,
  headContent: V2,
  revisions: { '1': V1, '2': V2 },
}
const W1 = 'w1\n'
const W2 = 'w2\n'
const otherB: SeedFile = {
  relPath: 'other/b.txt',
  content: W1,
  haveRev: 1,
  haveContent: W1,
  headRev: 2,
  headContent: W2,
  revisions: { '1': W1, '2': W2 },
}
const DIALOG_SUBMITTED: readonly P4SubmittedSeed[] = [
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
    description: 'b.txt to w2',
    rev: 2,
    files: [{ relPath: 'other/b.txt', action: 'edit', rev: 2 }],
  },
]

const DIALOG_READBACK_LOG = join(mkTempDir('p4-readback-dialog-'), 'readback.log')

test.describe('@p1 perforce graph sync point, a narrower dialog get asks the server', () => {
  test.use({
    p4Seeds: { files: [srcA, otherB], submitted: DIALOG_SUBMITTED },
    p4ExtraEnv: { UNIVERSE_P4_FAKE_READBACK_LOG: DIALOG_READBACK_LOG },
  })

  test('records the read-back answer, not the clicked row @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor.locator('[data-id="4522"]')).toBeVisible()

    // `Get Revision…` on a row of the whole-graph tab, then narrow the picked
    // scope to `src` — a scope the clicked row never touched. The listing the
    // row came from is the client root, so this get does NOT cover it.
    await editor.locator('[data-id="4522"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get Revision…', { exact: true }).click()

    const dialog = page.getByTestId('perforceGraph-syncDialog')
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    // Every candidate starts selected; dropping `other` leaves exactly `src`.
    await dialog.locator('input[type="checkbox"]').nth(1).click()
    await dialog.getByRole('button', { name: 'Get Revision (1)' }).click()

    // The get itself is real: src/a.txt moves #1 → #2 (the revision 4521 gave it).
    await expect
      .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
        timeout: 30_000,
        message: 'the dialog get should write revision #2 to src/a.txt',
      })
      .toBe(V2)

    // ...and it went the honest way round: with the picked scope narrower than
    // the listing, only p4 can say where the get landed. The fake logs the
    // question, so an implementation that trusts the row instead leaves this
    // empty (the renderer unit test pins WHICH scope it sends; this pins that
    // the extension then asks).
    await expect.poll(() => readbackLines(DIALOG_READBACK_LOG).length).toBeGreaterThan(0)

    // The answer must be 4521, not the clicked 4522. A tab scoped to the get's
    // own scope is what makes that visible: both records would badge `src`, and
    // only the right one names a changelist that touched it.
    await workbench.runCommand('workbench.action.closeAllEditors')
    await workbench.runCommand('perforce-graph.viewFileHistory', {
      resource: perforce.fileUri('src'),
      isDirectory: true,
    })
    const srcTab = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(srcTab).toBeVisible()
    const srcLine = srcTab.getByTestId('perforceGraph-syncPoint')
    await expect(srcLine).toHaveText('#4521')
    await expect(srcLine).toHaveAttribute('data-tooltip', /Recorded at/)
    await expect(srcTab.locator('[data-id="4521"]')).toContainText('Synced')
  })
})

// One more change that touched ONLY `other/`, so it appears in the whole-repo
// listing and nowhere in the opened folder's — the row that tells the two
// listings apart without reading any internal state.
const WIDE_SUBMITTED: readonly P4SubmittedSeed[] = [
  ...SPLIT_SUBMITTED,
  {
    changelist: '4523',
    user: 'e2e',
    time: '1751600200',
    description: 'c.txt outside the folder',
    rev: 1,
    files: [{ relPath: 'other/c.txt', action: 'add', rev: 1 }],
  },
]

const WIDE_READBACK_LOG = join(mkTempDir('p4-readback-wide-'), 'readback.log')

test.describe('@p1 perforce graph sync point, a whole-repo listing still asks', () => {
  test.use({
    p4Seeds: {
      files: [
        aTxt,
        { relPath: 'other/b.txt', content: 'b1\n' },
        { relPath: 'other/c.txt', content: 'c1\n' },
      ],
      submitted: WIDE_SUBMITTED,
    },
    openSubdir: 'src',
    p4ExtraEnv: { UNIVERSE_P4_FAKE_READBACK_LOG: WIDE_READBACK_LOG },
  })

  test('records a read-back answer instead of the row @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()

    // Widen to the whole repository. The globe toggle reloads the listing, and
    // 4523 is the row only the widened one can hold — waiting for it is how this
    // journey knows the menu below is opened over THAT listing. (Clicking during
    // the reload would send the previous listing's claim, which is a real
    // request shape and a different test.)
    const scopeToggle = editor.getByLabel('Toggle repository scope')
    await scopeToggle.click()
    await expect(scopeToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(editor.locator('[data-id="4523"]')).toBeVisible()

    // 4523 is the head row here, so this get asks for no confirmation.
    await editor.locator('[data-id="4523"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get This Revision', { exact: true }).click()

    // The badge moves either way — for `//...` the row's own changelist IS the
    // read-back's answer, since the clicked row is one of the changes the scope
    // lists. So the log is the whole point: the shortcut is deliberately not
    // available here (`//...` and the ledger's host paths are different
    // coordinate systems, see `docs/graph.md`), and an implementation that
    // extends it to this listing would leave the log empty.
    await expect(line).toHaveText('#4523')
    await expect.poll(() => readbackLines(WIDE_READBACK_LOG).length).toBeGreaterThan(0)
  })
})
