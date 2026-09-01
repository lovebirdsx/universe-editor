/*---------------------------------------------------------------------------------------------
 *  Perforce working-tree hint smoke (@p1).
 *
 *  A file modified on disk but never `p4 edit`-ed is invisible to the SCM model
 *  (p4 only tracks opened files), so the Explorer shows no decoration for it.
 *  The on-demand `checkWorkingTree` channel fills that gap: when an Explorer row
 *  renders, the host asks the provider which of the visible rows have drift it
 *  hasn't published, and gives the drifted row an "RC" badge.
 *
 *  Liveness-first, like perforceStatusDecorations.spec.ts: the drift assertion
 *  runs BEFORE the clean-file null assertion, so a spec with the whole channel
 *  deleted (provider command, service, or wiring) still fails instead of passing
 *  on the "clean file has no hint" zero-assertion alone.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { SeedFile } from '../fixtures/perforceApp.js'

const driftedFile: SeedFile = {
  relPath: 'drifted.txt',
  content: 'have revision content\n',
}
const cleanFile: SeedFile = {
  relPath: 'clean.txt',
  content: 'untouched\n',
}
// What the drifted file becomes on disk: differs from its have revision, but it
// is never `p4 edit`-ed — exactly the "uncollected drift" this channel surfaces.
const DRIFTED_CONTENT = 'edited on disk\n'

/** The probe's on-demand working-tree hint for a file (null = no hint). */
const hintFor = (page: Page, suffix: string) =>
  page.evaluate((s) => window.__E2E__!.getScmWorkingTreeHintForResource(s), suffix)

test.describe('@p1 perforce working-tree hint', () => {
  test.use({ p4Seeds: { files: [driftedFile, cleanFile] } })

  test('an uncollected drift gets an RC hint while a clean file gets none @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    // Drift the file before the workspace opens so the Explorer's first render of
    // the row is already looking at divergent disk content.
    writeFileSync(perforce.file(driftedFile.relPath), DRIFTED_CONTENT, 'utf8')

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    // Ensure both rows actually render — the hint channel is on-demand and only
    // queries rows that are on screen.
    await workbench.runCommand('workbench.view.explorer')
    await expect(page.locator('[role="treeitem"]', { hasText: driftedFile.relPath })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator('[role="treeitem"]', { hasText: cleanFile.relPath })).toBeVisible({
      timeout: 30_000,
    })

    // Liveness first: the drifted row resolves an RC hint. `getHint` is on-demand
    // (the first call only enqueues; the debounced batch resolves ~150ms later),
    // so poll instead of reading once. The rewrite re-triggers the file watcher —
    // which drops the cached hint and re-enqueues — in case the cold-start batch
    // raced the host's command registration. Re-arm a bounded number of times: the
    // hazard is a startup race, so if a handful of nudges haven't taken, more won't
    // either and the remaining polls should just observe rather than keep rewriting.
    let rearms = 0
    await expect
      .poll(
        async () => {
          const hint = await hintFor(page, driftedFile.relPath)
          if (hint?.letter !== 'RC' && rearms < 5) {
            rearms++
            writeFileSync(perforce.file(driftedFile.relPath), DRIFTED_CONTENT, 'utf8')
          }
          return hint
        },
        { timeout: 60_000, intervals: [500, 1000] },
      )
      .toEqual(expect.objectContaining({ letter: 'RC' }))

    // The clean file resolves to "no hint" (cached null → undefined → null).
    // Asserted AFTER liveness so a broken channel can't fake a pass here.
    await expect
      .poll(() => hintFor(page, cleanFile.relPath), {
        timeout: 30_000,
        message: 'the clean file should carry no working-tree hint',
      })
      .toBeNull()

    // Repro for "opening a diff for a drifted-but-unopened file shows the edit as
    // a full delete, and opening the source throws a `//` URI error". Root cause:
    // `p4 opened`/`reconcile -n` report `clientFile` in CLIENT SYNTAX (`//client/rel`),
    // not a local path — so readFile('//client/…') failed (empty modified side =
    // looks deleted) and the `//` path broke the file: URI. The fake p4 still emits
    // client syntax for those commands, so the RC hint above and the diff here
    // together guard the client→local translation end-to-end.
    await test.step('opening the diff for an RC-hinted file shows the real edit, not a phantom delete', async () => {
      // The RC badge proves the on-demand reconcile scan found the drift and
      // translated the client-syntax path back to the real local file. Now open
      // the diff through the same capability command a drifted row drives, and
      // assert the modified side is the real on-disk content — NOT empty (what a
      // broken client→local translation produced, rendering as a full delete).
      await workbench.runCommand('perforce.openChange', {
        resourceUri: perforce.file(driftedFile.relPath),
      })

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.modified), {
          timeout: 30_000,
          message: 'diff modified side should hold the working-tree content',
        })
        .toBe(DRIFTED_CONTENT)

      const diff = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
      // Left = have revision (the seeded content), right = the drift. If the
      // clientFile were still client syntax, modified would be '' and this would
      // look like a delete.
      expect(diff?.original).toBe(driftedFile.content)
      expect(diff?.modified).toBe(DRIFTED_CONTENT)
    })
  })
})
