/*---------------------------------------------------------------------------------------------
 *  Explorer directory Revert (@p1, @regression).
 *
 *  Guards the bug where right-clicking a directory in the Explorer → Perforce →
 *  Revert silently did nothing: the context menu always materializes the tree
 *  selection as the command's second argument (the single-clicked directory is
 *  part of that selection), so the handler's old "selection is empty AND primary
 *  isDirectory" fork could never fire. The directory fell into the per-file
 *  branch, `p4 opened <bare-dir>` matched nothing, the confirm asked to
 *  "Discard working-tree changes for 'sub'" (uncollected-only wording), and the
 *  only action was `p4 clean <bare-dir>` — not recursive, skipping opened files.
 *  Net effect: nothing happened at all.
 *
 *  The regression points: the confirm must use the leave-the-changelist wording
 *  (it lists the opened file — never the discard wording), and after Revert the
 *  opened file must be restored to its have revision AND leave the default
 *  changelist, while a drifted file outside the directory stays untouched.
 *
 *  The same command also drives the perforce drift group: a file inside the
 *  directory that is drifted on disk but NOT opened (the `p4 clean` half of the
 *  revert) must leave the resident `reconcile` SCM group, so the folder tint it
 *  produced clears (Bug C: "revert a folder and its yellow state must go away").
 *
 *  The second test covers the carve: an excluded subtree under the directory
 *  makes it a CARVED target, whose own level is covered by a single `<dir>/*`
 *  filespec (p4's non-recursive wildcard) instead of `<dir>/...`. That spec is
 *  the only thing standing between the carve and silent data loss — the level's
 *  files are not enumerable from disk (a locally deleted file has no readdir
 *  entry), so it has to be matched against the depot side. This test pins the
 *  level's delete + add both ways the spec is used: the discovery scan
 *  (`reconcile -n`, rows must appear) and the revert's `p4 clean` (the delete must
 *  be restored, the add discarded), with the excluded subtree untouched.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { SeedFile } from '../fixtures/perforceApp.js'

const RECONCILE_GROUP = 'reconcile'

const inner: SeedFile = {
  relPath: 'sub/inner.txt',
  content: 'inner have revision\n',
  // Already open for edit in the default changelist — the revert must take it
  // out of the changelist (via `p4 revert`) and restore the have revision.
  opened: { action: 'edit', change: 'default' },
}
const outside: SeedFile = {
  relPath: 'outside.txt',
  content: 'outside have revision\n',
}
/** Inside the reverted directory but never opened — the `p4 clean` half. */
const spare: SeedFile = {
  relPath: 'sub/spare.txt',
  content: 'spare have revision\n',
}

const seeds: readonly SeedFile[] = [inner, outside, spare]

/** Drifted on disk: diverges from the have revision but is not a new p4 edit. */
const drift = (seed: SeedFile): string => `drifted: ${seed.content}`

test.describe('@p1 explorer directory revert', () => {
  test.use({ p4Seeds: { files: seeds } })

  test(
    'reverting a directory leaves its opened files out of the changelist and restores them @regression',
    { tag: '@serial' },
    async ({ page, workbench, perforce }) => {
      test.setTimeout(120_000)
      await evaluateWhenRestored(page)

      // Drift every file before the workspace opens so the Explorer's first
      // render already sees divergent disk content.
      for (const seed of seeds) {
        writeFileSync(perforce.file(seed.relPath), drift(seed), 'utf8')
      }

      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)
      await waitForPerforceCommands(workbench)
      await workbench.showExplorer()

      // The seeded open state must have materialized as a default-changelist row.
      await expect
        .poll(
          () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), 'sub/inner.txt'),
          { timeout: 30_000, message: 'inner.txt should be opened in the default changelist' },
        )
        .toEqual(['default'])

      // The seeded child file `sub/spare.txt` was drifted but never opened, so
      // the reconcile scan surfaced it as a `reconcile` group row (the drift that
      // tints the `sub` folder — Bug C's pre-state).
      await expect
        .poll(
          () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), 'sub/spare.txt'),
          { timeout: 30_000, message: 'spare.txt should sit in the reconcile group' },
        )
        .toEqual([RECONCILE_GROUP])

      // Click (select) the directory row, then right-click it.
      const dirRow = page.locator('[role="treeitem"]', { hasText: 'sub' })
      await expect(dirRow).toBeVisible({ timeout: 60_000 })
      await dirRow.click()
      await dirRow.click({ button: 'right' })

      const menu = page.getByRole('menu').first()
      await expect(menu).toBeVisible({ timeout: 10_000 })
      const submenuRow = menu.getByRole('menuitem', { name: 'Perforce', exact: true })
      await expect(submenuRow).toBeVisible({ timeout: 10_000 })
      await submenuRow.hover()
      const panel = page.getByTestId('context-menu-submenu')
      await expect(panel).toBeVisible({ timeout: 10_000 })
      await panel.getByText('Revert', { exact: true }).click()

      // The confirm must speak about leaving the changelist and name the opened
      // file — the bug showed the uncollected-only "Discard working-tree
      // changes" wording (and then did nothing).
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await expect(dialog).toContainText('These files will leave their changelist')
      await expect(dialog).toContainText('inner.txt')
      await expect(dialog).not.toContainText('Discard working-tree changes')
      await dialog.getByRole('button', { name: 'Revert' }).click()

      // inner.txt lands back on its have revision and leaves the default
      // changelist (the `p4 revert <dir>/...` + `p4 clean <dir>/...` pair).
      await expect
        .poll(() => readFileSync(perforce.file(inner.relPath), 'utf8'), {
          timeout: 30_000,
          message: 'inner.txt should be restored to its have revision',
        })
        .toBe(inner.content)
      await expect
        .poll(
          () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), 'sub/inner.txt'),
          { timeout: 30_000, message: 'inner.txt should no longer be in any changelist' },
        )
        .toEqual([])

      // The `p4 clean sub/...` half also restored the drifted-but-unopened child:
      // its disk content returns to the have revision (Bug C — its row was the
      // tint source, and that row leaves with the drift). Disk first, group
      // second: Revert is a two-step run (`p4 revert`, refresh, `p4 clean`,
      // refresh), and the group is transiently empty during the refresh between
      // the steps — an absence-poll on the group can be satisfied a moment before
      // the clean has written anything, so the file content is the only ground
      // truth that the clean landed.
      await expect
        .poll(() => readFileSync(perforce.file(spare.relPath), 'utf8'), {
          timeout: 30_000,
          message: 'spare.txt should be restored to its have revision by the clean',
        })
        .toBe(spare.content)
      await expect
        .poll(
          () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), 'sub/spare.txt'),
          { timeout: 30_000, message: 'spare.txt should no longer be in any SCM group' },
        )
        .toEqual([])

      // The revert was scoped to the directory: the drifted file outside it is
      // untouched (its drift survives; it was never opened).
      expect(readFileSync(perforce.file(outside.relPath), 'utf8')).toBe(drift(outside))
    },
  )
})

/** The exclusion that turns `sub` into a carved target. */
const EXCLUDED_REL = 'sub/excluded'
const excluded: SeedFile = {
  relPath: `${EXCLUDED_REL}/kept.txt`,
  content: 'excluded have revision\n',
}
/** Directly under the carved level (`sub`), a depot file that leaves the disk —
 *  a delete no readdir-based enumeration can see. */
const levelDeleted: SeedFile = {
  relPath: 'sub/deleted.txt',
  content: 'level have revision\n',
}
/** Directly under the carved level too: a file the depot never knew. */
const LEVEL_ADDED_REL = 'sub/added.txt'
const LEVEL_ADDED_CONTENT = 'added at the carve level\n'
/** Drift inside the excluded subtree — invisible to reconcile, surviving clean. */
const EXCLUDED_DRIFT = 'drifted inside the excluded folder\n'

const exclusionSeeds: readonly SeedFile[] = [excluded, levelDeleted]

test.describe('@p1 explorer directory revert around an exclusion', () => {
  test.use({ p4Seeds: { files: exclusionSeeds } })

  test(
    'the carve keeps the level files and skips the excluded subtree @regression',
    { tag: '@serial' },
    async ({ page, workbench, perforce }) => {
      test.setTimeout(180_000)
      await evaluateWhenRestored(page)

      // The exclusion must be in the project settings BEFORE the workspace opens:
      // the cold-start scan is armed once per session and reads the resolved
      // excludes then, so this is what makes the scan carve `sub` (and the root,
      // whose subtree holds the exclusion) rather than ask `<sub>/...`.
      const settingsDir = join(perforce.clientRoot, '.universe-editor')
      mkdirSync(settingsDir, { recursive: true })
      writeFileSync(
        join(settingsDir, 'settings.json'),
        JSON.stringify({ 'perforce.reconcile.excludeFolders': [EXCLUDED_REL] }),
        'utf8',
      )

      // Level drift on both sides of the filesystem — the two shapes a `/*` spec
      // has to reach and a disk walk cannot fully produce: a depot file that is
      // gone from disk, and a file that is only on disk. Done before the workspace
      // opens so the cold-start scan discovers them; no watcher is involved.
      rmSync(perforce.file(levelDeleted.relPath))
      writeFileSync(perforce.file(LEVEL_ADDED_REL), LEVEL_ADDED_CONTENT, 'utf8')
      writeFileSync(perforce.file(excluded.relPath), EXCLUDED_DRIFT, 'utf8')

      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)
      await waitForPerforceCommands(workbench)
      await workbench.showExplorer()

      const groupsOf = (rel: string) =>
        page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), rel)

      // The level spec at work: both level drifts reach Changes even though `sub`
      // is carved around its excluded descendant. The DELETE is the load-bearing
      // one — its file has no readdir entry, so only a `<sub>/*` answered from the
      // depot side can name it (a fake that matched specs by disk shape made this
      // row vanish, and the level looked "lost" when the exclusion was applied).
      for (const rel of [levelDeleted.relPath, LEVEL_ADDED_REL]) {
        await expect
          .poll(() => groupsOf(rel), {
            timeout: 60_000,
            message: `${rel} sits at the carved level and must still reach Changes`,
          })
          .toEqual([RECONCILE_GROUP])
      }
      // …while the exclusion still holds: nothing under the excluded subtree is
      // collected, so it has no row at all.
      expect(await groupsOf(excluded.relPath)).toEqual([])

      // Revert `sub`. The carve feeds this clean (`<sub>/*` plus the clean
      // subtrees — never `<sub>/...`, which would walk the excluded subtree), so
      // the level's delete must come back and its add must go away.
      const dirRow = page.locator('[role="treeitem"]', { hasText: 'sub' })
      await expect(dirRow).toBeVisible({ timeout: 60_000 })
      await dirRow.click()
      await dirRow.click({ button: 'right' })

      const menu = page.getByRole('menu').first()
      await expect(menu).toBeVisible({ timeout: 10_000 })
      const submenuRow = menu.getByRole('menuitem', { name: 'Perforce', exact: true })
      await expect(submenuRow).toBeVisible({ timeout: 10_000 })
      await submenuRow.hover()
      const panel = page.getByTestId('context-menu-submenu')
      await expect(panel).toBeVisible({ timeout: 10_000 })
      await panel.getByText('Revert', { exact: true }).click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await expect(dialog).toContainText("Discard working-tree changes under 'sub'")
      await dialog.getByRole('button', { name: 'Revert' }).click()

      // The clean's `<sub>/*` restored the locally deleted level file…
      await expect
        .poll(
          () => {
            try {
              return readFileSync(perforce.file(levelDeleted.relPath), 'utf8')
            } catch {
              return null
            }
          },
          { timeout: 30_000, message: 'the level delete should be restored by the clean' },
        )
        .toBe(levelDeleted.content)
      // …discarded the level add (an `add` in the same spec's rows)…
      await expect
        .poll(() => existsSync(perforce.file(LEVEL_ADDED_REL)), {
          timeout: 30_000,
          message: 'the level add should be discarded by the clean',
        })
        .toBe(false)
      // …and never named the excluded subtree, whose drift must survive untouched.
      expect(readFileSync(perforce.file(excluded.relPath), 'utf8')).toBe(EXCLUDED_DRIFT)
    },
  )
})
