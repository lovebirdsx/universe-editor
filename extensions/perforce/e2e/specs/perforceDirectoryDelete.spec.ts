/*---------------------------------------------------------------------------------------------
 *  Deleting a directory must show up in Changes (@p1).
 *
 *  The reported bug: delete a FOLDER inside the editor and Perforce's Changes
 *  group lists nothing, while adding / editing / deleting a single FILE all work.
 *
 *  The mechanism is the event shape. Deleting through the editor goes to the
 *  recycle bin (`shell.trashItem` = a same-volume rename), so the whole subtree
 *  leaves the watched tree in one syscall and the watcher reports ONE delete event
 *  for the directory path — the files inside are moved along with it and never get
 *  events of their own. A bare path is p4's single-FILE filespec and a path that
 *  no longer exists names no file at all, so the old per-path query answered
 *  "no file(s) to reconcile" (exit 0) and the whole subtree stayed invisible.
 *
 *  This spec pins the OUTCOME (the deletions reach the Changes group) and the
 *  query SHAPE that gets there (every concrete spec for a vanished path carries
 *  its `<path>/...` twin), so it holds whether the platform reports one directory
 *  event or one event per file.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, mkTempDir } from '@universe-editor/e2e-harness'
import type { SeedFile } from '../fixtures/perforceApp.js'

const deletedA: SeedFile = { relPath: 'gone/a.txt', content: 'a\n' }
const deletedB: SeedFile = { relPath: 'gone/b.txt', content: 'b\n' }
const kept: SeedFile = { relPath: 'keep.txt', content: 'kept\n' }

/** Where the fake p4 appends every reconcile argv (see the fixture's docs). The
 *  fake answers from disk state, so "the row appeared" is satisfied just as well
 *  by a query that asked the wrong filespec — a log of what p4 was actually
 *  handed is the only place the shape can be asserted. */
const argvLog = join(mkTempDir('ue2-p4-argv-'), 'reconcile.log')

/** The fake's reconcile log, one argv per line ('' before the first spawn). */
function reconcileLog(): string[] {
  try {
    return readFileSync(argvLog, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** The filespecs of a logged `reconcile` argv (everything after `-d`), or [] when
 *  the line is not a reconcile. Space-split, so seeded paths must stay space-free. */
function specsOf(line: string): string[] {
  const args = line.split(' ')
  const at = args.indexOf('-d')
  return at === -1 ? [] : args.slice(at + 1)
}

const isWildcard = (spec: string): boolean => /[/\\](\.\.\.|\*)$/.test(spec)

/** The concrete specs under the deleted directory whose `<path>/...` twin is
 *  missing from the same batch — the shape the fix guarantees is impossible. */
function missingTwins(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const specs = specsOf(line)
    for (const spec of specs) {
      if (isWildcard(spec) || !/[/\\]gone([/\\]|$)/.test(spec)) continue
      if (!specs.includes(`${spec}/...`)) out.push(spec)
    }
  }
  return out
}

test.describe('@p1 perforce directory delete', () => {
  test.use({
    p4Seeds: { files: [deletedA, deletedB, kept] },
    p4ExtraEnv: { UNIVERSE_P4_FAKE_ARGV_LOG: argvLog },
  })

  test('deleting a directory reports its whole subtree as drift @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
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

    // Render the rows so the Explorer-side machinery is warm before the delete.
    await workbench.showExplorer()
    await expect(page.locator('[role="treeitem"]', { hasText: kept.relPath })).toBeVisible({
      timeout: 30_000,
    })

    // The cold-start scan reads the DISK with one `<root>/...` batch. A deletion
    // that lands while that batch is still running is reported by the scan, not by
    // the watcher flush this spec guards, and the group assertion below would pass
    // on a build with the bug. Wait for the scan to have asked and the log to go
    // quiet first — and a mistimed deletion is not silent: the shape assertion
    // needs a `gone` line that only the flush produces.
    await expect
      .poll(
        async () => {
          const lines = reconcileLog()
          if (!lines.some(isWildcardLine)) return false
          const before = lines.length
          await new Promise((resolve) => setTimeout(resolve, 400))
          return reconcileLog().length === before
        },
        {
          timeout: 60_000,
          message: 'the cold-start reconcile scan should have asked and gone quiet',
        },
      )
      .toBe(true)

    // Delete the folder the way the editor does: a same-volume rename (the
    // recycle bin is one). NOT `rmSync` — Node deletes a tree child by child, and
    // those per-file deletes would take the single-file path and pass on a build
    // that cannot see a deleted directory at all.
    const trash = mkTempDir('ue2-p4-trash-')
    renameSync(perforce.file('gone'), join(trash, 'gone'))

    // The outcome the user reported as broken: the files that were inside the
    // folder are drift, and the untouched sibling is not.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmGroupIdsForResource('gone/a.txt')), {
        timeout: 60_000,
        message: 'a file deleted as part of a folder should land in Changes',
      })
      .toContain('reconcile')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmGroupIdsForResource('gone/b.txt')), {
        timeout: 30_000,
        message: 'every file of the deleted folder should land in Changes',
      })
      .toContain('reconcile')
    expect(
      await page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), kept.relPath),
    ).not.toContain('reconcile')

    // The shape that gets there, asserted over the log rather than assumed from
    // the event: every concrete spec the flush hands p4 for a path under the
    // deleted directory must carry its `<path>/...` twin. One directory event
    // (Windows) and one event per file (other platforms) both satisfy this — and
    // a build that asks the bare path alone satisfies neither, which is exactly
    // the bug.
    await expect
      .poll(
        () => {
          const lines = reconcileLog().filter(
            (l) => l.includes('-n') && /[/\\]gone([/\\]|$)/.test(l),
          )
          return lines.length > 0 && missingTwins(lines).length === 0
        },
        {
          timeout: 30_000,
          message:
            'the flush must ask for a vanished path as its bare form AND `<path>/...` — a bare spec names no file, which is the reported bug',
        },
      )
      .toBe(true)
  })
})

/** A logged argv whose every spec is recursive/wildcard — the scan's own batch. */
function isWildcardLine(line: string): boolean {
  const specs = specsOf(line)
  return specs.length > 0 && specs.every(isWildcard)
}
