/*---------------------------------------------------------------------------------------------
 *  Perforce sync history (@p1).
 *
 *  Every get the editor runs leaves one record, and the host's Sync History page
 *  renders them from the extension's JSON file. Four journeys, one cold launch
 *  each:
 *
 *  1. A get from the Explorer writes exactly ONE record (not one per p4 batch),
 *     and the page shows what the run did: outcome, target, counts, the scope it
 *     covered, and which surface started it.
 *  2. A run that FAILS still leaves a record, and it does so while the get is
 *     still parked on its error dialog. This is the journey the ledger cannot
 *     cover: `graphSyncLedger` records only gets it can express as a claim, so a
 *     clobbered get is invisible there — and it would be invisible in the history
 *     too if the recorder sat after the failure's early return.
 *  3. The I/O columns distinguish "no sampler" from "moved 0 bytes". The same
 *     workspace, the same get, twice: once with the scripted sampler, once with
 *     sampling off. The second must read as unavailable.
 *
 *  Neither the row's text nor the completion toast is the settle signal: rows all
 *  carry the same words ("Updated", "#head"), and a toast can be dismissed by the
 *  time a later assertion runs. Every journey instead polls the record through
 *  `perforce-sync-history.getRuns` — the very command the page reads — which is a
 *  fact for an applied, a failed and a cancelled run alike.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  test,
  expect,
  waitForPerforceCommands,
  type SeedFile,
} from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Locator, Page } from '@playwright/test'

const FAKE_IO_PROBE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/fake-p4-io-probe.mjs',
)

const GET_RUNS = 'perforce-sync-history.getRuns'

// The client has #1 and the depot head is #2, so the get has real work to do
// (an up-to-date get is recorded too, but it would not exercise counts).
const HEAD_CONTENT = 'head two\n'
const behind: SeedFile = {
  relPath: 'src/a.txt',
  content: 'have one\n',
  headRev: 2,
  headContent: HEAD_CONTENT,
}

// `clobber`: a plain `p4 sync` (no `-f`) aborts the whole run with exit 1 and
// "can't clobber writable file" on stderr — the failure path a record has to
// survive.
const blocked: SeedFile = {
  relPath: 'src/b.txt',
  content: 'local draft\n',
  headRev: 2,
  headContent: HEAD_CONTENT,
  clobber: true,
}

interface RecordedRun {
  readonly id: string
  readonly outcome: string
  readonly spec: string
  readonly trigger: string
  readonly counts?: { readonly applied: number }
}

async function openPerforceWorkspace(
  page: Page,
  workbench: WorkbenchPO,
  openDir: string,
): Promise<void> {
  // Cold boot + host relaunch on workspace open.
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
}

/** Fire a get and DON'T await it: for an applied run the command resolves only
 *  after its completion toast is dealt with, and a refused one parks on an error
 *  dialog — neither is this spec's business. Callers poll for the record. */
async function startGet(page: Page, file: string): Promise<void> {
  await page.evaluate(
    (uri) => void window.__E2E__!.runCommand('perforce.syncLatest', { resourceUri: uri }),
    file,
  )
}

/** The recorded runs, read through the command the page itself reads. */
async function recordedRuns(page: Page): Promise<readonly RecordedRun[]> {
  return page.evaluate(async (cmd: string) => {
    const page = (await window.__E2E__!.runCommand(cmd, {})) as
      | { runs?: readonly RecordedRun[] }
      | undefined
    return page?.runs ?? []
  }, GET_RUNS)
}

async function waitForRecordCount(page: Page, count: number): Promise<void> {
  await expect
    .poll(async () => (await recordedRuns(page)).length, {
      timeout: 30_000,
      message: `the history should hold exactly ${count} record(s)`,
    })
    .toBe(count)
}

async function openHistory(page: Page, workbench: WorkbenchPO): Promise<Locator> {
  await workbench.runCommand('perforce-sync-history.view')
  const view = page.getByTestId('perforce-sync-history')
  await expect(view).toBeVisible({ timeout: 30_000 })
  return view
}

test.describe('@p1 perforce sync history', () => {
  test.describe('recording a get', () => {
    test.use({ p4Seeds: { files: [behind] } })

    test('records one run and shows what it did, where and from where @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      await openPerforceWorkspace(page, workbench, perforce.openDir)

      await startGet(page, perforce.file('src/a.txt'))
      await waitForRecordCount(page, 1)
      // The record precedes the completion toast, so this is what makes it a
      // record of a get that really landed rather than of an attempted one. The
      // disk is the signal, not `haveRev`: the fake (like the real server)
      // drops the explicit `haveRev` once a file sits at head, and #2 IS head
      // here — `haveRev` would read `undefined` for a perfectly synced file.
      await expect
        .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), { timeout: 30_000 })
        .toBe(HEAD_CONTENT)

      const view = await openHistory(page, workbench)
      const rows = view.getByTestId('perforce-sync-history-row')
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toHaveAttribute('data-outcome', 'applied')
      await expect(view.getByTestId('perforce-sync-history-count')).toHaveText('1 run(s)')

      // The newest run is selected on load, so the detail pane is describing the
      // row above.
      await expect(view.getByTestId('perforce-sync-history-detail')).toBeVisible()
      await expect(view.getByTestId('perforce-sync-history-detail-outcome')).toHaveText('Updated')
      await expect(view.getByTestId('perforce-sync-history-detail-target')).toContainText('#head')
      await expect(view.getByTestId('perforce-sync-history-detail-files')).toContainText(
        '1 updated',
      )
      // The range as a host path — not the escaped filespec p4 was handed.
      await expect(view.getByTestId('perforce-sync-history-detail-scope')).toContainText('a.txt')
      // And the surface the user actually clicked.
      await expect(view.getByTestId('perforce-sync-history-detail-trigger')).toHaveText('Explorer')
    })
  })

  test.describe('a get that failed', () => {
    test.use({ p4Seeds: { files: [blocked] } })

    test('is recorded before its error dialog, so a refused get is not invisible @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      await openPerforceWorkspace(page, workbench, perforce.openDir)

      await startGet(page, perforce.file('src/b.txt'))
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await expect(dialog).toContainText('Get revision failed')
      // The record is on disk while the get is still parked here: written before
      // the (await-ed) dialog, which is exactly what keeps `durationMs` a measure
      // of the get instead of of how long the user left the dialog open.
      await waitForRecordCount(page, 1)
      // Dismiss the refusal so the parked command finishes; the remedies it
      // offers are another spec's journey.
      await page.keyboard.press('Escape')

      const view = await openHistory(page, workbench)
      const rows = view.getByTestId('perforce-sync-history-row')
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toHaveAttribute('data-outcome', 'failed')
      await expect(view.getByTestId('perforce-sync-history-detail-outcome')).toHaveText('Failed')
      // p4 ran and exited 1 without per-file counts — the pane must not claim the
      // get never ran.
      await expect(view.getByTestId('perforce-sync-history-detail-files')).toHaveText(
        'not reported by p4',
      )
    })
  })

  test.describe('the I/O columns', () => {
    test.use({
      p4Seeds: { files: [behind] },
      p4ExtraEnv: {
        UNIVERSE_P4_IO_PROBE: FAKE_IO_PROBE,
        // The scripted sampler's first delta lands on its 1s tick, so the run has
        // to outlive that tick for there to be a number at all. Ticks from the
        // second one on move the write counter instead of the read one, which is
        // what makes both columns non-zero rather than just the first.
        UNIVERSE_P4_FAKE_SYNC_START_MS: '5000',
        UNIVERSE_P4_FAKE_IO_WRITE_FROM_TICK: '2',
      },
    })

    test('report the sampled byte totals @regression', async ({ page, workbench, perforce }) => {
      await openPerforceWorkspace(page, workbench, perforce.openDir)

      await startGet(page, perforce.file('src/a.txt'))
      await waitForRecordCount(page, 1)

      const view = await openHistory(page, workbench)
      await expect(view.getByTestId('perforce-sync-history-row')).toHaveCount(1)
      // Non-zero on BOTH: a sampler that ran and moved bytes must not be shown as
      // unavailable, and a column wired to the wrong counter would read 0B.
      await expect(view.getByTestId('perforce-sync-history-detail-read')).toHaveText(/[1-9]/)
      await expect(view.getByTestId('perforce-sync-history-detail-write')).toHaveText(/[1-9]/)
      // Disk writes come from the watcher, so they are stated as a lower bound
      // rather than as a bare number.
      await expect(view.getByTestId('perforce-sync-history-detail-diskwrites')).toContainText('≥')
    })
  })

  test.describe('the I/O columns with sampling off', () => {
    test.use({
      p4Seeds: { files: [behind] },
      // The fixture's default: no OS sampler on this platform.
      p4ExtraEnv: { UNIVERSE_P4_IO_PROBE: 'off' },
    })

    test('read as unavailable instead of zero @regression', async ({ page, workbench, perforce }) => {
      await openPerforceWorkspace(page, workbench, perforce.openDir)

      await startGet(page, perforce.file('src/a.txt'))
      await waitForRecordCount(page, 1)

      const view = await openHistory(page, workbench)
      await expect(view.getByTestId('perforce-sync-history-row')).toHaveCount(1)
      // The whole point of the column: a machine that cannot measure must say so.
      // `0B` here would claim the get transferred nothing.
      for (const id of ['perforce-sync-history-detail-read', 'perforce-sync-history-detail-write']) {
        await expect(view.getByTestId(id)).toHaveText('unavailable (no sampler on this platform)')
      }
    })
  })
})
