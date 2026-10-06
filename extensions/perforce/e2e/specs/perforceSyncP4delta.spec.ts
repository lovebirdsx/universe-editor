/*---------------------------------------------------------------------------------------------
 *  δ serves the plain get (@p1, @regression).
 *
 *  The editor's default get is `p4 sync` semantics — protect what p4 protects,
 *  never walk over uncollected local work — and p4delta answers exactly that
 *  since its `--sync` split (`--force` took the repair, `--sync` became the
 *  normal get). An engine swap of a WRITE is only proven by both halves, so
 *  every journey asserts the shape of the call AND the world after it:
 *
 *    - the δ argv carries `--sync -a` and the scope the user asked for, while
 *      the native p4 argv log stays free of `sync` — the delegated child's env
 *      is stripped of that log, so a line there can only be the extension
 *      itself;
 *    - the bytes on disk moved (or, for the refusal, did not).
 *
 *  Two journeys, one cold launch each:
 *  1. A file get runs on δ, lands head, and leaves the sibling alone.
 *  2. A locally-modified file p4 refuses is reported as a refusal — folded into
 *     the answer, NOT re-served natively (the work the refusal protects is
 *     exactly what a second run would put at risk).
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateWhenRestored, mkTempDir, type WorkbenchPO } from '@universe-editor/e2e-harness'
import { readArgvLog, test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import type { SeedFile } from '../fixtures/perforceApp.js'
import type { Page } from '@playwright/test'

// Depot head is one revision ahead of the have revision: the file is a get away
// from head, and a get for it really moves bytes.
const HAVE = 'have revision one\n'
const HEAD = 'head revision two\n'
const behind: SeedFile = {
  relPath: 'behind.txt',
  content: HAVE,
  headRev: 2,
  headContent: HEAD,
}
const SIBLING_HAVE = 'have sibling\n'
const SIBLING_HEAD = 'head sibling\n'
const sibling: SeedFile = {
  relPath: 'sibling.txt',
  content: SIBLING_HAVE,
  headRev: 2,
  headContent: SIBLING_HEAD,
}

// The `allwrite noclobber` shape: p4 skips this file with "can't update modified
// file" on the engine's stderr and carries on with exit 0.
const DRAFT = 'my uncollected work\n'
const REFUSED_HEAD = 'head refused\n'
const refused: SeedFile = {
  relPath: 'refused.txt',
  content: DRAFT,
  headRev: 2,
  headContent: REFUSED_HEAD,
  refused: true,
}

/** Fresh logs per journey: a shared file would make the "never asked natively"
 *  assertion depend on what the other journeys did. */
function makeLogs(): { delta: string; p4: string } {
  return {
    delta: join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log'),
    p4: join(mkTempDir('ue2-p4-argv-'), 'p4.log'),
  }
}

/** δ's own gets, by the two flags that make one: `--sync` and the `-a` that
 *  turns the preview into the write. */
const deltaSyncLines = (log: string): string[] =>
  readArgvLog(log).filter((l) => /(^| )--sync( |$)/.test(l) && /(^| )-a( |$)/.test(l))

/** A `sync` the EXTENSION handed to p4 itself. The δ fake strips the log from
 *  the child it delegates to, so δ's internal p4 calls never appear here — a
 *  line is only ever the native engine. */
const nativeSyncLines = (log: string): string[] =>
  readArgvLog(log).filter((l) => /(^| )sync( |$)/.test(l))

/** The entries of a logged argv (what followed the `--` separator). */
const entriesOf = (line: string): string[] => line.split(' -- ')[1]?.split(' ') ?? []

/** Open the seeded workspace, wait for the provider + command registration. */
async function openSyncWorkspace(
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

test.describe('@p1 perforce p4delta get', () => {
  test.describe('a plain get runs on delta', () => {
    const logs = makeLogs()
    test.use({
      p4Seeds: { files: [behind, sibling] },
      p4delta: {},
      p4ExtraEnv: {
        UNIVERSE_P4DELTA_ARGV_LOG: logs.delta,
        UNIVERSE_P4_FAKE_ARGV_LOG: logs.p4,
      },
    })

    test('get latest lands the head revision through δ, and never asks p4 for it @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      await page.evaluate(
        (p) => void window.__E2E__!.runCommand('perforce.syncLatest', { resourceUri: p }),
        perforce.file(behind.relPath),
      )

      // The world after it: head on disk. p4 refuses to lose local work — the
      // claim under test is that δ's get does too, not that it merely reported
      // success.
      await expect
        .poll(() => readFileSync(perforce.file(behind.relPath), 'utf8'), {
          timeout: 30_000,
          message: 'the get should write the head revision to disk',
        })
        .toBe(HEAD)
      // …and the get was scoped to the one file: the sibling is still on its
      // have revision.
      expect(readFileSync(perforce.file(sibling.relPath), 'utf8')).toBe(SIBLING_HAVE)

      // The shape of the call: δ got `--sync -a` over that file's own path. `-a`
      // is what separates the write from the preview δ runs as its plan, and the
      // entry is what keeps the run scoped to what the user asked for.
      await expect
        .poll(
          () =>
            deltaSyncLines(logs.delta).filter((l) =>
              entriesOf(l).includes(perforce.file(behind.relPath)),
            ).length,
          { timeout: 30_000, message: 'the get should hand δ --sync -a and the file scope' },
        )
        .toBeGreaterThan(0)

      // The other engine never ran a get at all. δ still did its scans, so this
      // is not the "no engine configured" world.
      expect(nativeSyncLines(logs.p4)).toEqual([])
      expect(readArgvLog(logs.delta).length).toBeGreaterThan(0)

      await expect(
        page
          .locator('[data-testid="notification-toast-item"]')
          .filter({ hasText: 'Updated 1 file(s)' }),
      ).toBeVisible({ timeout: 30_000 })
    })
  })

  test.describe('a refusal is folded, not re-served', () => {
    const logs = makeLogs()
    test.use({
      p4Seeds: { files: [refused] },
      p4delta: {},
      p4ExtraEnv: {
        UNIVERSE_P4DELTA_ARGV_LOG: logs.delta,
        UNIVERSE_P4_FAKE_ARGV_LOG: logs.p4,
      },
    })

    test('a file p4 refuses is reported as refused and the draft survives @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      await page.evaluate(
        (p) => void window.__E2E__!.runCommand('perforce.syncLatest', { resourceUri: p }),
        perforce.file(refused.relPath),
      )

      // The refusal reaches the user: p4's own message rides δ's stderr, and the
      // count in the dialog is what tells them why nothing moved.
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await expect(dialog).toContainText('not updated')
      // The way out is the lossless one, same as on the native path.
      await expect(dialog.getByRole('button', { name: 'Collect Changes' })).toBeVisible()

      // The draft is untouched — this is the whole point of the refusal.
      expect(readFileSync(perforce.file(refused.relPath), 'utf8')).toBe(DRAFT)

      // δ answered, so its answer stands: the refusal is NOT a failed run to
      // re-serve. A second, native attempt would be exactly the run that
      // overwrites what the refusal just protected.
      expect(deltaSyncLines(logs.delta).length).toBeGreaterThan(0)
      expect(nativeSyncLines(logs.p4)).toEqual([])
    })
  })
})
