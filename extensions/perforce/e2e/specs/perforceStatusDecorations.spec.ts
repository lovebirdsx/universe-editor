/*---------------------------------------------------------------------------------------------
 *  Perforce Explorer supplementary (grey-text) decorations smoke (@p1).
 *
 *  The grey text trailing an Explorer row is the provider's *supplementary*
 *  decoration channel — a file's server-side condition that exists outside any
 *  resource group. Four journeys, one cold launch each, against the fake p4:
 *
 *  1. A file behind the depot head (`headRev` > have) carries grey
 *     "update available" text with a tooltip naming the pending revision —
 *     produced by the behind-check (two-tier probe) that runs at startup.
 *  2. A file open in ANOTHER client carries grey "in use by others" text with a
 *     `user@client` tooltip. The local path must come from reversing the depot
 *     path (`p4 where`) — under `opened -a` the record's `clientFile` is the
 *     OTHER client's client-syntax path (`//otherclient/…`), and translating it
 *     with this client's root manufactures a local path that doesn't exist, so
 *     the grey text would hang off no real file row and this probe would read
 *     null.
 *  3. One file both behind AND open by others publishes as ONE merged entry
 *     (the renderer keys decorations by path, so two entries would silently
 *     overwrite each other): the short text is the combined marker and the
 *     tooltip keeps each producer's full detail, joined by a newline.
 *  4. A clean file carries no decoration at all. Deliberately paired in the
 *     same run with a file that DOES get decorated: the zero-assertion alone
 *     also passes when the whole decoration channel is broken, so the liveness
 *     assertion must come first.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { SeedFile } from '../fixtures/perforceApp.js'

// Depot head is one revision ahead of what the client has synced — the
// behind-check's `sync -n` then reports the file with action `updated` at #2.
const behindFile: SeedFile = {
  relPath: 'behind.txt',
  content: 'have revision one\n',
  headRev: 2,
  headContent: 'head revision two\n',
}
// Open for edit in another client: `p4 opened -a` reports it with the other
// client's client-syntax `clientFile` (see the header, journey 2).
const occupiedFile: SeedFile = {
  relPath: 'occupied.txt',
  content: 'shared content\n',
  openedBy: { user: 'testuser', client: 'otherclient' },
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

test.describe('@p1 perforce status decorations', () => {
  test.describe('behind grey text', () => {
    test.use({ p4Seeds: { files: [behindFile, cleanFile] } })

    test('a file behind the depot head shows grey "update available" text @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openStatusWorkspace(page, workbench, perforce.openDir)

      // The behind-check runs once at startup (its cheap gate falls through on
      // the fake depot), then publishes the per-file marker.
      await expect
        .poll(() => decoFor(page, 'behind.txt'), {
          timeout: 60_000,
          message: 'the behind file should carry the grey "update available" marker',
        })
        .toEqual(
          expect.objectContaining({
            description: 'update available',
            descriptionTooltip: expect.stringContaining('updated #2'),
          }),
        )
    })
  })

  test.describe('opened-by-others grey text', () => {
    test.use({ p4Seeds: { files: [occupiedFile, cleanFile] } })

    test('a file open in another client shows grey "in use by others" text @regression', async ({
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
          message: 'the occupied file should carry the grey "in use by others" marker',
        })
        .toEqual(
          expect.objectContaining({
            description: 'in use by others',
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

  test.describe('behind and occupied merge into one entry', () => {
    test.use({ p4Seeds: { files: [bothFile, cleanFile] } })

    test('one file both behind and open by others publishes one merged marker @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openStatusWorkspace(page, workbench, perforce.openDir)

      // The merged description only appears once BOTH scans have completed and
      // the merge ran — polling it waits for the whole chain, not just one half.
      await expect
        .poll(async () => (await decoFor(page, 'both.txt'))?.description, {
          timeout: 60_000,
          message: 'the merged marker should replace the two single-fact markers',
        })
        .toBe('in use by others · update available')

      // Both producers keep their full detail in the merged tooltip (joined by
      // a newline), so neither fact is lost by the merge.
      const deco = await decoFor(page, 'both.txt')
      expect(deco?.descriptionTooltip).toContain('updated #2')
      expect(deco?.descriptionTooltip).toContain('testuser@otherclient')
    })
  })

  test.describe('clean files carry no decoration', () => {
    test.use({ p4Seeds: { files: [cleanFile, behindFile] } })

    test('a clean file has no decoration while a behind file in the same run does @regression', async ({
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
        .poll(() => decoFor(page, 'behind.txt'), {
          timeout: 60_000,
          message: 'the behind file should get its decoration in the same run',
        })
        .toEqual(expect.objectContaining({ description: 'update available' }))

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
