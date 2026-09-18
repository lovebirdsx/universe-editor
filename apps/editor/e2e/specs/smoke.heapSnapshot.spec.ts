/*---------------------------------------------------------------------------------------------
 *  Controlled heap snapshots (P1): one REAL capture, through the REAL command.
 *
 *  Everything downstream of the decision is a claim about a real Electron renderer writing a
 *  real V8 object graph to a real file, and none of it can be established by a fake:
 *
 *    - the consent dialog is a gate, not decoration — the command must raise it, and it must
 *      come through the renderer's own dialog queue (a stray `confirm()` or a silently
 *      skipped prompt would make the freeze arrive unannounced)
 *    - `webContents.takeHeapSnapshot` produces a file this process can hand to Chrome's
 *      heap profiler: complete (a `.partial` that got renamed, not a truncated leftover) and
 *      recognisably a snapshot (its JSON envelope)
 *    - the renderer comes back after the freeze, i.e. the capture did not wedge the window
 *    - the round ends when the user stops it and when the window reloads — the heap it
 *      measured no longer exists after either
 *    - the diagnostics zip carries the snapshot's *listing* and never its bytes: that zip is
 *      uploaded to an issue tracker, and a snapshot is a copy of whatever strings the heap
 *      held (file contents, prompts, credentials)
 *
 *  Timing is the round's own: a baseline needs 60s of arm age plus three samples inside a 10%
 *  band, on the renderer's 30s report throttle. A first attempt that lands while the heap is
 *  still moving restarts the band, and a resource reading that failed once (the boot-time
 *  PowerShell commit query, for instance) only comes back on the sampler's backoff — so the
 *  wait is minutes. The spec waits it out rather than shortening it, because those thresholds
 *  are the feature.
 *
 *  It does NOT manufacture a GB-sized heap and does NOT touch anyone's real userData: the
 *  cold fixture gives each test its own throwaway one. When the machine itself is short on
 *  memory or disk, the round refuses (every refusal carries its own code) and the spec
 *  reports that as a SKIP with the reason rather than passing — an unrelated machine
 *  constraint must never read as "verified". A refusal that does *not* name a shortage is a
 *  defect in this build and fails here, because skipping it would hide a broken reading
 *  behind a green tick.
 *--------------------------------------------------------------------------------------------*/

import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import type { Page } from '@playwright/test'
import { waitForProbe } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/electronApp.js'

/** Where main puts snapshots — deliberately not under logs/. */
const SNAPSHOT_REL_DIR = ['diagnostics', 'heap-snapshots']

/**
 * Refusal codes that mean "this machine is short on a resource", not "the feature broke".
 * Only the explicit *-low codes count: `commit-unknown` / `disk-unknown` mean a reading could
 * not be taken at all, and a reading that never works is a defect in this build (a broken WMI
 * query, a statfs that always fails) — a build that cannot read its own machine must fail the
 * spec, not skip it. Skip ≠ pass on this machine; a skip that also hides a code error is worse.
 */
const MACHINE_REFUSALS: readonly string[] = [
  'physical-memory-low',
  'commit-headroom-low',
  'disk-space-low',
]

/**
 * main's own last word on the round, straight from the file the feature writes it to:
 * `<userData>/logs/<session>/heapSnapshot.log`. The window's status DTO only carries a
 * code once the round has *ended* (`_stop`), so a round that spent the whole wait being
 * refused by a resource gate reports `active: true` with no code at all — reading the
 * decision here is what keeps "blocked by a gate" from looking like "stuck for no reason".
 */
function lastDecisionLine(userData: string): string | undefined {
  let sessions: string[]
  try {
    sessions = readdirSync(join(userData, 'logs'))
  } catch {
    return undefined
  }
  const newest = sessions.sort().at(-1)
  if (newest === undefined) return undefined
  let text: string
  try {
    text = readFileSync(join(userData, 'logs', newest, 'heapSnapshot.log'), 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split('\n').filter((line) => line.includes('heap-snapshot '))
  return lines.at(-1)?.trim()
}

interface SnapshotInventory {
  readonly snapshots: readonly string[]
  readonly partials: readonly string[]
  readonly metadata: readonly string[]
}

function readInventory(userData: string): SnapshotInventory {
  let names: string[]
  try {
    names = readdirSync(join(userData, ...SNAPSHOT_REL_DIR))
  } catch {
    return { snapshots: [], partials: [], metadata: [] }
  }
  return {
    // Order matters: a `.heapsnapshot.partial` also ends with `.heapsnapshot` under a naive
    // `includes`, so filter the longer suffix out first.
    partials: names.filter((name) => name.endsWith('.heapsnapshot.partial')),
    snapshots: names.filter(
      (name) => name.endsWith('.heapsnapshot') && !name.endsWith('.heapsnapshot.partial'),
    ),
    metadata: names.filter((name) => name.endsWith('.json')),
  }
}

/**
 * A bounded read of one end of a file. V8 heap snapshots are single-line JSON objects
 * (`{"snapshot":{"meta":…},"nodes":[…]}`), so the head identifies the format and the tail
 * proves it was written to the end — without pulling hundreds of MB into the test process.
 */
function readEdge(path: string, edge: 'head' | 'tail', bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, edge === 'head' ? 0 : size - length)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * A round is only finished once *both* of its files are on disk: main renames the `.partial`
 * first and writes the sidecar right after, so a listing that sees the `.heapsnapshot` can
 * still be looking at a round whose metadata has not landed — and everything this spec asserts
 * afterwards (trigger, status, the pairing of bytes to window) would then be read from a
 * directory that was still being written. Wait for the pair, not for the first half of it.
 */
function readCompletedSnapshot(
  userData: string,
): { snapshot: string; sidecar: string } | undefined {
  const inventory = readInventory(userData)
  const snapshot = inventory.snapshots[0]
  if (snapshot === undefined || inventory.snapshots.length !== 1) return undefined
  const sidecar = `${snapshot.slice(0, -'.heapsnapshot'.length)}.json`
  return inventory.metadata.includes(sidecar) ? { snapshot, sidecar } : undefined
}

/** The dialog the start command must raise before anything is captured. */
function consentDialog(page: Page) {
  return page.getByRole('dialog').filter({ hasText: 'Start memory diagnosis for this window?' })
}

/** Arm a round the way a user does: real command, real dialog, real button. */
async function startRound(page: Page): Promise<void> {
  // The handler awaits the dialog, so awaiting the command here would deadlock the spec.
  void page
    .evaluate(
      () => void window.__E2E__!.runCommand('workbench.action.startHeapSnapshotDiagnostics'),
    )
    .catch(() => {})

  const dialog = consentDialog(page)
  await expect(dialog).toBeVisible()
  // What the user is agreeing to: a freeze, a copy of whatever the heap held, this machine
  // only. Each of these is a sentence the dialog has to keep.
  const text = (await dialog.textContent()) ?? ''
  expect(text).toContain('pauses this window')
  expect(text).toContain('credentials')
  expect(text).toContain('never uploaded automatically')
  await dialog.getByRole('button', { name: 'Start Diagnosis' }).click()
}

/** A round's own pacing: 60s of arm age, then 3 samples inside the band, sampled on the
 *  renderer's 30s report throttle. A first attempt that lands on a moving heap simply
 *  restarts the band, and a resource reading that failed once (the boot-time PowerShell
 *  query, say) comes back on the sampler's own backoff — so the wait is minutes, not
 *  seconds, and it is the feature's real cost rather than a number this spec gets to pick. */
const CAPTURE_WAIT_MS = 420_000

test.describe('@p1 controlled heap snapshots', () => {
  test('captures a real baseline through the command consent dialog', async ({
    electronApp,
    page,
    workbench,
  }) => {
    test.setTimeout(CAPTURE_WAIT_MS + 120_000)
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))

    await startRound(page)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getHeapSnapshotStatus()), { timeout: 20_000 })
      .toMatchObject({ active: true, phase: 'baseline' })

    try {
      await expect
        .poll(() => readCompletedSnapshot(userData), {
          timeout: CAPTURE_WAIT_MS,
          intervals: [1_000],
        })
        .toBeDefined()
    } catch (err) {
      // Either the machine refused a resource or the round is stuck; both have to be named,
      // never folded into a bare timeout. A refusal that names a *shortage* is reported as a
      // skip: the feature is not verifiable here, and "not verified" is not "passed". A
      // refusal that names a *broken reading* is not — see MACHINE_REFUSALS.
      const status = await page.evaluate(() => window.__E2E__!.getHeapSnapshotStatus())
      const decision = lastDecisionLine(userData) ?? '(the app wrote no heap-snapshot line)'
      const reason = `no baseline after ${CAPTURE_WAIT_MS / 1000}s: ${decision} [active=${status.active} phase=${status.phase} attempts=${status.attempts}/${status.attemptLimit} app=${status.appAttempts}/${status.appAttemptLimit}]`
      const refused = MACHINE_REFUSALS.find((code) => decision.includes(`code=${code}`))
      if (refused !== undefined) {
        test.skip(true, `unverified on this machine — ${refused}: ${reason}`)
      }
      throw new Error(reason, { cause: err })
    }

    // The temp userData is thrown away with the app, so keep main's own record of the capture
    // in the run output: this is what makes "a real snapshot was taken" auditable afterwards.
    console.log(`heap snapshot: ${lastDecisionLine(userData) ?? '(no decision line)'}`)

    const inventory = readInventory(userData)
    // Exactly one finished file, and nothing left half-written: the partial is renamed only
    // after the API returns and the target identity still matches.
    expect(inventory.snapshots).toHaveLength(1)
    expect(inventory.partials).toEqual([])
    expect(inventory.metadata).toHaveLength(1)

    const snapshotPath = join(userData, ...SNAPSHOT_REL_DIR, inventory.snapshots[0]!)
    expect(inventory.snapshots[0]).toMatch(/^heap-baseline-w\d+-/)

    // A renamed partial is not enough on its own — the bytes have to be a whole snapshot.
    expect(statSync(snapshotPath).size).toBeGreaterThan(0)
    expect(readEdge(snapshotPath, 'head', 4096)).toContain('{"snapshot":')
    expect(readEdge(snapshotPath, 'head', 4096)).toContain('"meta"')
    expect(readEdge(snapshotPath, 'tail', 4096).trimEnd().endsWith('}')).toBe(true)

    // The sidecar is what a reader has instead of the object graph: which window and renderer
    // produced it, how big the heap was when the decision was made, how long it froze.
    const sidecar = JSON.parse(
      readFileSync(join(userData, ...SNAPSHOT_REL_DIR, inventory.metadata[0]!), 'utf8'),
    ) as Record<string, unknown>
    expect(sidecar).toMatchObject({ trigger: 'baseline', status: 'complete' })
    expect(sidecar['snapshotBytes']).toBe(statSync(snapshotPath).size)
    expect(typeof sidecar['pid']).toBe('number')
    expect(typeof sidecar['durationMs']).toBe('number')

    // The freeze ends: the renderer answers again, and the round reported the capture to the
    // window that owns it (the report is an IPC event, so a missing toast means a dead hop).
    expect(['Starting', 'Ready', 'Restored', 'Eventually']).toContain(
      await workbench.lifecyclePhase(),
    )
    const messages = await page.evaluate(() =>
      window.__E2E__!.getNotifications().map((entry) => entry.message),
    )
    expect(messages).toEqual(
      expect.arrayContaining([expect.stringContaining('The baseline snapshot was written')]),
    )

    // Stop: the round reports itself over, and writes nothing further.
    await workbench.runCommand('workbench.action.stopHeapSnapshotDiagnostics')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getHeapSnapshotStatus()), { timeout: 10_000 })
      .toMatchObject({ active: false, code: 'stopped-by-user' })
    expect(readInventory(userData).snapshots).toHaveLength(1)

    // The zip that gets uploaded to a tracker carries the listing, never the object graph.
    await workbench.runCommand('workbench.action.exportDiagnostics')
    const diagnosticsDir = join(userData, 'diagnostics')
    await expect
      .poll(
        () => {
          try {
            return readdirSync(diagnosticsDir).filter((name) => name.endsWith('.zip'))
          } catch {
            return []
          }
        },
        { timeout: 30_000 },
      )
      .toHaveLength(1)
    const zipName = readdirSync(diagnosticsDir).find((name) => name.endsWith('.zip'))!
    const zip = new AdmZip(join(diagnosticsDir, zipName))
    const entryNames = zip.getEntries().map((entry) => entry.entryName)
    expect(entryNames).toContain('heap-snapshots.txt')
    expect(entryNames.filter((name) => name.includes('heapsnapshot'))).toEqual([])
    const manifest = zip.readAsText('heap-snapshots.txt')
    // The listing has to actually name the file, otherwise "the zip does not contain the
    // snapshot" would also hold for a zip that never knew about it.
    expect(manifest).toContain(inventory.snapshots[0]!)
    expect(manifest).toContain('no content is included in this zip')
  })

  test('a window reload ends the round instead of leaving it armed', async ({
    electronApp,
    page,
  }) => {
    test.setTimeout(120_000)
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))

    await startRound(page)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getHeapSnapshotStatus()), { timeout: 20_000 })
      .toMatchObject({ active: true })

    const loaded = page.waitForEvent('load')
    void page
      .evaluate(() => void window.__E2E__!.runCommand('workbench.action.reloadWindow'))
      .catch(() => {})
    await loaded
    await waitForProbe(page)

    // The renderer that was being measured is gone; main has to say so, not keep waiting for
    // samples from a heap that no longer exists.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getHeapSnapshotStatus()), { timeout: 20_000 })
      .toMatchObject({ active: false, code: 'window-reloaded' })
    expect(readInventory(userData).snapshots).toEqual([])
  })
})
