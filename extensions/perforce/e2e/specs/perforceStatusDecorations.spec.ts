/*---------------------------------------------------------------------------------------------
 *  Perforce Explorer supplementary (grey-text) decorations smoke (@p1).
 *
 *  The grey text trailing an Explorer row is the provider's *supplementary*
 *  decoration channel — a file's server-side condition that exists outside any
 *  resource group. Two journeys, one cold launch each, against the fake p4:
 *
 *  1. A file open in ANOTHER client carries grey "✎" text with a
 *     `user@client` tooltip. The local path must come from reversing the depot
 *     path (`p4 where`) — under `opened -a` the record's `clientFile` is the
 *     OTHER client's client-syntax path (`//otherclient/…`), and translating it
 *     with this client's root manufactures a local path that doesn't exist, so
 *     the grey text would hang off no real file row and this probe would read
 *     null.
 *  2. A clean file carries no decoration at all. Deliberately paired in the
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
