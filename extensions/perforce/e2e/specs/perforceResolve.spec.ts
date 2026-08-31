/*---------------------------------------------------------------------------------------------
 *  Perforce resolve (needs-merge) smoke (@p1).
 *
 *  Covers the "Needs Resolve" chain end to end against the fake p4
 *  (fixtures/fake-p4.mjs). Four journeys, one cold launch each:
 *
 *  1. A file seeded with `opened.resolve: 'conflict'` surfaces in the pinned
 *     Needs Resolve group (`RESOLVE_GROUP_ID`); accepting the incoming side
 *     (`perforce.resolveAcceptTheirs`, behind a destructive-op confirm) drops
 *     the row AND writes the head content to disk.
 *  2. THE core guard: `p4 resolve -am` exits 0 even when files are left
 *     unresolved — the extension must still surface "Auto-merged N; M still
 *     need manual resolution." with an action button. This journey fires the
 *     resolve from BOTH entry points (per-row multi-select and the whole-group
 *     `perforce.resolveChangelist`), because the group entry is the more common
 *     click and used to take the exit-code-only `_mutate` path that swallowed
 *     the partial outcome silently.
 *  3. `perforce.openMergeEditor` opens the 3-way merge editor (base have vs
 *     head, labels prove the stages). Completing it must run the perforce
 *     saveCommand — asserted by its observable consequence: saving accepts the
 *     resolution (`resolve -ay`), so the file leaves the Needs Resolve group.
 *     A direct "which command ran" probe doesn't exist; if the save fell back
 *     to the generic `git.stage` (the pre-neutralization behaviour) nothing
 *     would clear p4's unresolved state and this poll would stay red.
 *  4. Resolving when nothing is left reports completion instead of being
 *     silent or erroring: a second resolve on an already-auto-merged file
 *     answers with the "Resolve completed." info toast.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { SeedFile } from '../fixtures/perforceApp.js'

const RESOLVE_GROUP = 'resolve'
const DEFAULT_GROUP = 'default'

// Depot head is one revision ahead of the have revision, so accepting theirs /
// auto-merging has real incoming content to land (and the merge editor gets
// distinct base/current/incoming stages).
const MINE = 'mine line one\n'
const THEIRS = 'theirs line two\n'
const conflicted: SeedFile = {
  relPath: 'conflict.txt',
  content: MINE,
  headRev: 2,
  headContent: THEIRS,
  opened: { resolve: 'conflict' },
}
const autoMerged: SeedFile = {
  relPath: 'auto.txt',
  content: 'auto have\n',
  headRev: 2,
  headContent: 'auto head\n',
  opened: { resolve: 'merge' },
}

/** Open the seeded workspace, wait for the provider + command registration. */
async function openResolveWorkspace(
  page: Page,
  workbench: WorkbenchPO,
  openDir: string,
): Promise<void> {
  await evaluateWhenRestored(page)
  await workbench.openWorkspace(openDir)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
      timeout: 60_000,
      message: 'perforce extension should register a source control for the workspace',
    })
    .toBeGreaterThan(0)
  await waitForPerforceCommands(workbench)
}

/** Group ids whose resource list contains the file (suffix-matched path). */
const groupIdsFor = (page: Page, suffix: string) =>
  page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), suffix)

test.describe('@p1 perforce resolve', () => {
  test.describe('accept theirs clears the row', () => {
    test.use({ p4Seeds: { files: [conflicted] } })

    test('a needs-resolve file leaves the group after accepting theirs @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openResolveWorkspace(page, workbench, perforce.openDir)

      await test.step('the unresolved file surfaces in Needs Resolve', async () => {
        // Liveness first: everything below only means something once the row
        // really appeared.
        await expect
          .poll(() => groupIdsFor(page, conflicted.relPath), {
            timeout: 30_000,
            message: 'the unresolved file should appear in the Needs Resolve group',
          })
          .toEqual(expect.arrayContaining([RESOLVE_GROUP]))
      })

      await test.step('accepting theirs confirms, then drops the row and writes head', async () => {
        // Destructive op: the command blocks on its confirm dialog, so it must
        // be fired without awaiting (the dialog click below would deadlock).
        void page
          .evaluate(
            (p) =>
              void window.__E2E__!.runCommand('perforce.resolveAcceptTheirs', { resourceUri: p }),
            perforce.file(conflicted.relPath),
          )
          .catch(() => {})
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText('by accepting the incoming version')
        await dialog.getByRole('button', { name: 'Accept Theirs' }).click()

        // `resolve -at` clears the server's unresolved flag — the row leaves
        // the Needs Resolve group (it stays open in its changelist)…
        await expect
          .poll(() => groupIdsFor(page, conflicted.relPath), {
            timeout: 30_000,
            message: 'the file should leave the Needs Resolve group after -at',
          })
          .toEqual([DEFAULT_GROUP])
        // …and the incoming head content really landed on disk.
        await expect
          .poll(() => readFileSync(perforce.file(conflicted.relPath), 'utf8'), {
            timeout: 30_000,
            message: 'the incoming head content should be written to disk',
          })
          .toBe(THEIRS)
      })
    })
  })

  test.describe('partial success reports the split outcome', () => {
    test.use({ p4Seeds: { files: [autoMerged, conflicted] } })

    const SUMMARY = 'Auto-merged 1; 1 still need manual resolution.'
    const BTN_RESOLVE = 'Resolve Conflicts'

    test('row-level resolve reports the auto-merged/remaining split @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openResolveWorkspace(page, workbench, perforce.openDir)

      await test.step('both unresolved files surface in Needs Resolve', async () => {
        await expect
          .poll(() => groupIdsFor(page, autoMerged.relPath), {
            timeout: 30_000,
            message: 'the mergeable file should appear in the Needs Resolve group',
          })
          .toEqual(expect.arrayContaining([RESOLVE_GROUP]))
        await expect
          .poll(() => groupIdsFor(page, conflicted.relPath), {
            timeout: 30_000,
            message: 'the conflicted file should appear in the Needs Resolve group',
          })
          .toEqual(expect.arrayContaining([RESOLVE_GROUP]))
      })

      await test.step('a per-row multi-select resolve reports the split, with an action', async () => {
        // Mirrors what an SCM row inline action sends: (primary, full selection).
        // p4 exits 0 here — only the summary proves the run was not silent.
        void page
          .evaluate(
            ([auto, conflict]) =>
              void window.__E2E__!.runCommand('perforce.resolve', { resourceUri: auto }, [
                { resourceUri: auto },
                { resourceUri: conflict },
              ]),
            [perforce.file(autoMerged.relPath), perforce.file(conflicted.relPath)] as const,
          )
          .catch(() => {})
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText(SUMMARY)
        await expect(dialog.getByRole('button', { name: BTN_RESOLVE })).toBeVisible()

        // The action hands off to the 3-way merge editor on the first
        // still-unresolved file.
        await dialog.getByRole('button', { name: BTN_RESOLVE }).click()
        await expect(page.getByTestId('merge-editor')).toBeVisible({ timeout: 30_000 })

        // The mergeable file landed, the conflicted one stayed unresolved.
        await expect
          .poll(() => groupIdsFor(page, autoMerged.relPath), {
            timeout: 30_000,
            message: 'the auto-merged file should leave the Needs Resolve group',
          })
          .toEqual([DEFAULT_GROUP])
        await expect
          .poll(() => groupIdsFor(page, conflicted.relPath), {
            timeout: 30_000,
            message: 'the conflicted file should stay in the Needs Resolve group',
          })
          .toEqual(expect.arrayContaining([RESOLVE_GROUP]))
      })
    })

    test('group-level resolve reports the same split outcome @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openResolveWorkspace(page, workbench, perforce.openDir)

      await test.step('both unresolved files surface in Needs Resolve', async () => {
        await expect
          .poll(() => groupIdsFor(page, autoMerged.relPath), {
            timeout: 30_000,
            message: 'the mergeable file should appear in the Needs Resolve group',
          })
          .toEqual(expect.arrayContaining([RESOLVE_GROUP]))
        await expect
          .poll(() => groupIdsFor(page, conflicted.relPath), {
            timeout: 30_000,
            message: 'the conflicted file should appear in the Needs Resolve group',
          })
          .toEqual(expect.arrayContaining([RESOLVE_GROUP]))
      })

      await test.step('the whole-group resolve reports the split instead of swallowing it', async () => {
        // `perforce.resolveChangelist` on the default changelist — the same
        // exit-code-only trap, reached through the higher-frequency entry.
        void page
          .evaluate(
            () =>
              void window.__E2E__!.runCommand('perforce.resolveChangelist', {
                scmResourceGroupId: 'default',
              }),
          )
          .catch(() => {})
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText(SUMMARY)
        await expect(dialog.getByRole('button', { name: BTN_RESOLVE })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()

        await expect
          .poll(() => groupIdsFor(page, autoMerged.relPath), {
            timeout: 30_000,
            message: 'the auto-merged file should leave the Needs Resolve group',
          })
          .toEqual([DEFAULT_GROUP])
        await expect
          .poll(() => groupIdsFor(page, conflicted.relPath), {
            timeout: 30_000,
            message: 'the conflicted file should stay in the Needs Resolve group',
          })
          .toEqual(expect.arrayContaining([RESOLVE_GROUP]))
      })
    })
  })

  test.describe('merge editor save accepts the resolution', () => {
    test.use({ p4Seeds: { files: [conflicted] } })

    test('opening the 3-way merge editor and saving leaves the needs-resolve group @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openResolveWorkspace(page, workbench, perforce.openDir)

      await expect
        .poll(() => groupIdsFor(page, conflicted.relPath), {
          timeout: 30_000,
          message: 'the unresolved file should appear in the Needs Resolve group',
        })
        .toEqual(expect.arrayContaining([RESOLVE_GROUP]))

      await workbench.runCommand('perforce.openMergeEditor', perforce.file(conflicted.relPath))

      // The loaded merge editor (not the loading placeholder) shows the
      // Complete Merge button plus the perforce-side stage labels — proves the
      // three-way editor really opened on have vs head.
      const complete = page.getByTestId('merge-complete')
      await expect(complete).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('merge-editor')).toContainText('Yours (have #1)')
      await expect(page.getByTestId('merge-editor')).toContainText('Theirs (head #2)')

      // The seeded file carries no conflict markers, so nothing blocks the
      // save. Saving writes the result and runs the perforce saveCommand
      // (`perforce.acceptResolved` → `resolve -ay`): the file leaving the
      // group below is that command's observable consequence — a generic
      // `git.stage` fallback (the pre-neutralization behaviour) clears nothing
      // in p4 and would keep this poll red forever.
      await expect(complete).toBeEnabled()
      await complete.click()

      await expect
        .poll(() => groupIdsFor(page, conflicted.relPath), {
          timeout: 30_000,
          message: 'saving the merge editor should accept the resolution and drop the row',
        })
        .toEqual([DEFAULT_GROUP])
      await expect(page.getByTestId('merge-editor')).toHaveCount(0, { timeout: 30_000 })
    })
  })

  test.describe('nothing left to resolve', () => {
    test.use({ p4Seeds: { files: [autoMerged] } })

    test('re-resolving an already-resolved file reports completion instead of failing @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openResolveWorkspace(page, workbench, perforce.openDir)

      await expect
        .poll(() => groupIdsFor(page, autoMerged.relPath), {
          timeout: 30_000,
          message: 'the unresolved file should appear in the Needs Resolve group',
        })
        .toEqual(expect.arrayContaining([RESOLVE_GROUP]))

      // First resolve auto-merges the file (the all-done info toast).
      await workbench.runCommand('perforce.resolve', {
        resourceUri: perforce.file(autoMerged.relPath),
      })
      await expect(
        page
          .locator('[data-testid="notification-toast-item"]')
          .filter({ hasText: 'Auto-merged 1 file(s).' }),
      ).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() => groupIdsFor(page, autoMerged.relPath), {
          timeout: 30_000,
          message: 'the auto-merged file should leave the Needs Resolve group',
        })
        .toEqual([DEFAULT_GROUP])

      // Second resolve: p4 answers "no file(s) to resolve" (exit 0) — the
      // extension must not be silent and must not error.
      await workbench.runCommand('perforce.resolve', {
        resourceUri: perforce.file(autoMerged.relPath),
      })
      await expect(
        page
          .locator('[data-testid="notification-toast-item"]')
          .filter({ hasText: 'Resolve completed.' }),
      ).toBeVisible({ timeout: 30_000 })
    })
  })
})
