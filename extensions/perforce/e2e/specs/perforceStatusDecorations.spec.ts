/*---------------------------------------------------------------------------------------------
 *  Perforce Explorer supplementary (grey-text) decorations smoke (@p1).
 *
 *  The grey text trailing an Explorer row is the provider's *supplementary*
 *  decoration channel — a file's server-side condition that exists outside any
 *  resource group. Five journeys, one cold launch each, against the fake p4:
 *
 *  1. A file open in ANOTHER client carries grey "✎" text with a
 *     `user@client` tooltip, produced by the startup opened-by-others scan
 *     (`opened -a`). The local path must come from reversing the depot path
 *     (`p4 where`) — under `opened -a` the record's `clientFile` is the
 *     OTHER client's client-syntax path (`//otherclient/…`), and translating it
 *     with this client's root manufactures a local path that doesn't exist, so
 *     the grey text would hang off no real file row and this probe would read
 *     null.
 *  2. A file behind the depot head (`headRev` > have) carries grey "↓" text
 *     with a tooltip naming the head revision. Unlike the startup scan above,
 *     the behind probe is ON-DEMAND: only Explorer rows that actually render
 *     get the per-file fstat that publishes the marker (no full `sync -n`
 *     sweep at startup anymore), so the journey must reveal the row first.
 *  3. One file both behind AND open by others publishes as ONE merged entry
 *     (the renderer keys decorations by path, so two entries would silently
 *     overwrite each other): the short text is the combined marker and the
 *     tooltip keeps each producer's full detail, joined by a newline.
 *  4. A successful sync to head clears the "↓" marker: the sync clears the
 *     behind map eagerly and invalidates the fstat cache, and the next
 *     render's re-fstat finds have == head and publishes nothing.
 *  5. A clean file carries no decoration at all. Deliberately paired in the
 *     same run with a file that DOES get decorated: the zero-assertion alone
 *     also passes when the whole decoration channel is broken, so the liveness
 *     assertion must come first.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { SeedFile } from '../fixtures/perforceApp.js'

// Open for edit in another client: `p4 opened -a` reports it with the other
// client's client-syntax `clientFile` (see the header, journey 1).
const occupiedFile: SeedFile = {
  relPath: 'occupied.txt',
  content: 'shared content\n',
  openedBy: { user: 'testuser', client: 'otherclient' },
}
// Depot head is one revision ahead of what the client has synced — the
// behind-check's per-row `fstat` reports `headRev` > `haveRev` (#2 vs #1).
const behindFile: SeedFile = {
  relPath: 'behind.txt',
  content: 'have revision one\n',
  headRev: 2,
  headContent: 'head revision two\n',
}
const bothFile: SeedFile = {
  relPath: 'both.txt',
  content: 'have revision one\n',
  headRev: 2,
  headContent: 'head revision two\n',
  openedBy: { user: 'testuser', client: 'otherclient' },
}
const cleanFile: SeedFile = {
  relPath: 'clean.txt',
  content: 'untouched\n',
}

/** The probe's decoration record for a file (null = zero decorations). */
const decoFor = (page: Page, suffix: string) =>
  page.evaluate((s) => window.__E2E__!.getScmDecorationForResource(s), suffix)

/** Open the seeded workspace, wait for the provider + command registration. */
async function openStatusWorkspace(
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

/** Open the Explorer and wait for the file row to actually render — the behind
 *  probe is on-demand and only queries rows that are on screen, so the row must
 *  exist before its decoration can be published. */
async function revealExplorerRow(
  page: Page,
  workbench: WorkbenchPO,
  relPath: string,
): Promise<void> {
  await workbench.runCommand('workbench.view.explorer')
  await expect(page.locator('[role="treeitem"]', { hasText: relPath })).toBeVisible({
    timeout: 30_000,
  })
}

test.describe('@p1 perforce status decorations', () => {
  test.describe('opened-by-others grey text', () => {
    test.use({ p4Seeds: { files: [occupiedFile, cleanFile] } })

    test('a file open in another client shows grey "✎" text @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openStatusWorkspace(page, workbench, perforce.openDir)

      // The opened-by-others scan runs once at startup. Its local path is the
      // `p4 where` reverse of the depot path — a product bug that translated the
      // other client's clientFile with its own clientRoot would key the grey
      // text under a path that doesn't exist, and this probe (which matches by
      // the real file's path suffix) would keep reading null forever.
      await expect
        .poll(() => decoFor(page, 'occupied.txt'), {
          timeout: 60_000,
          message: 'the occupied file should carry the grey "✎" marker',
        })
        .toEqual(
          expect.objectContaining({
            description: '✎',
            descriptionTooltip: expect.stringContaining('testuser@otherclient'),
          }),
        )

      // Guard: the marker must hang off the real local path, never the other
      // client's syntax. If the scan had used the record's raw `clientFile`
      // (`//otherclient/…`) as the resource path, the renderer would key the
      // decoration under that syntax — this probe for it must read null.
      expect(await decoFor(page, 'otherclient/occupied.txt')).toBeNull()
    })
  })

  test.describe('behind grey text', () => {
    test.use({ p4Seeds: { files: [behindFile, cleanFile] } })

    test('a file behind the depot head shows grey "↓" text @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openStatusWorkspace(page, workbench, perforce.openDir)

      // The behind probe is driven by visible rows, not a startup sweep: the
      // Explorer rendering `behind.txt` is what enqueues its per-file fstat, so
      // the row must be on screen before the marker can exist. Polling without
      // this step would time out even when the channel is healthy.
      await revealExplorerRow(page, workbench, behindFile.relPath)

      await expect
        .poll(() => decoFor(page, behindFile.relPath), {
          timeout: 60_000,
          message: 'the behind file should carry the grey "↓" marker',
        })
        .toEqual(
          expect.objectContaining({
            description: '↓',
            descriptionTooltip: expect.stringContaining('#2'),
          }),
        )
    })
  })

  test.describe('behind and occupied merge into one entry', () => {
    test.use({ p4Seeds: { files: [bothFile, cleanFile] } })

    test('one file both behind and open by others publishes one merged marker @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openStatusWorkspace(page, workbench, perforce.openDir)

      // Both producers feed the same renderer key, so two unmerged entries would
      // silently overwrite each other. The merged marker needs the occupied
      // startup scan AND the visible-row behind fstat — reveal the row exactly
      // like the behind journey before polling the combined marker.
      await revealExplorerRow(page, workbench, bothFile.relPath)

      await expect
        .poll(async () => (await decoFor(page, bothFile.relPath))?.description, {
          timeout: 60_000,
          message: 'the merged marker should replace the two single-fact markers',
        })
        .toBe('✎ ↓')

      // Both producers keep their full detail in the merged tooltip (joined by
      // a newline), so neither fact is lost by the merge.
      const deco = await decoFor(page, bothFile.relPath)
      expect(deco?.descriptionTooltip).toContain('#2')
      expect(deco?.descriptionTooltip).toContain('testuser@otherclient')
    })
  })

  test.describe('sync clears the behind marker', () => {
    test.use({ p4Seeds: { files: [behindFile] } })

    test('syncing the head revision clears the grey "↓" text @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openStatusWorkspace(page, workbench, perforce.openDir)

      // Liveness first: the marker must exist before its disappearance can mean
      // anything — a null poll alone would also pass if the channel were broken.
      await revealExplorerRow(page, workbench, behindFile.relPath)
      await expect
        .poll(() => decoFor(page, behindFile.relPath), {
          timeout: 60_000,
          message: 'the behind file should get its decoration before the sync',
        })
        .toEqual(expect.objectContaining({ description: '↓' }))

      await workbench.runCommand('perforce.syncLatest', {
        resourceUri: perforce.file(behindFile.relPath),
      })

      // A successful sync clears the behind map eagerly and invalidates the
      // fstat cache. This poll relies on the cleared push, and on the next
      // render re-fstatting the row (have == head now) and publishing nothing —
      // the decoration is render-triggered, so if the row is ever not re-probed,
      // re-revealing the Explorer (switch away and back, or scroll) re-arms it.
      await expect
        .poll(() => decoFor(page, behindFile.relPath), {
          timeout: 60_000,
          message: 'the grey "↓" marker should disappear after syncing to head',
        })
        .toBeNull()
    })
  })

  test.describe('clean files carry no decoration', () => {
    test.use({ p4Seeds: { files: [cleanFile, occupiedFile] } })

    test('a clean file has no decoration while an occupied file in the same run does @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openStatusWorkspace(page, workbench, perforce.openDir)

      // Liveness first: this poll only passes when the decoration channel is
      // actually working in this run. Without it, the null assertion below
      // would also pass if the whole channel were deleted.
      await expect
        .poll(() => decoFor(page, 'occupied.txt'), {
          timeout: 60_000,
          message: 'the occupied file should get its decoration in the same run',
        })
        .toEqual(expect.objectContaining({ description: '✎' }))

      // The real assertion: a file that is current, unoccupied and locally
      // unchanged carries nothing.
      await expect
        .poll(() => decoFor(page, 'clean.txt'), {
          timeout: 30_000,
          message: 'the clean file should carry zero decorations',
        })
        .toBeNull()
    })
  })
})
