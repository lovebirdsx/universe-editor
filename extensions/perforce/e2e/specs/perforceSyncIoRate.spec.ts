/*---------------------------------------------------------------------------------------------
 *  Perforce sync status-bar I/O rate + target (@p1).
 *
 *  The bug this covers: a wide sync spends its first minutes walking the depot
 *  server-side with no stdout at all and no workspace file touched yet, so both
 *  the file count and the watcher's `disk +N` sit at 0 and the status bar reads
 *  as stalled exactly when the user is watching it start.
 *
 *  The fix reads the p4 process's own OS I/O counters and shows a rate in the
 *  body. The real sampler is per-platform (a PowerShell/WMI poller on Windows,
 *  `/proc/<pid>/io` on Linux) and cannot report a pinned number, so this spec
 *  drives the `UNIVERSE_P4_IO_PROBE` seam with a scripted sampler emitting a
 *  growing delta per second, and holds the fake p4 silent for a configurable
 *  startup window (`UNIVERSE_P4_FAKE_SYNC_START_MS`) to reproduce the real
 *  server-side walk. Together they pin the acceptance criterion end to end: a
 *  non-zero rate on screen while `done` is still 0.
 *
 *  The sampler also models the SECOND half of a real sync
 *  (`UNIVERSE_P4_FAKE_IO_WRITE_FROM_TICK`): from that tick on the read counter
 *  freezes and the deltas go to the write counter, which is what p4 does once it
 *  stops pulling from the server and starts landing staged content. A read-only
 *  rate decays to `000KB/s` right there — the bar reads as stalled while the disk
 *  is busiest — so the token is the SUM of both counters and this spec asserts it
 *  stays non-zero on a window that holds nothing but write growth.
 *
 *  The token is asserted to be exactly 7 characters wide at every sample — the
 *  status bar is a row, so a rate whose text grows a character as it crosses 10
 *  or 100 would shove every neighbouring entry sideways once a second.
 *
 *  The tooltip carries the target revision for the whole run, and keeps naming it
 *  after the run ends (the completion notification is dismissed or missed, and
 *  "which changelist did I just get?" is asked afterwards).
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, waitForPerforceCommands, type SeedFile } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'

const FAKE_IO_PROBE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/fake-p4-io-probe.mjs',
)

// Depot head is a revision ahead of what the client has synced, so the get has
// real work to do rather than answering "file(s) up-to-date.".
const behind: SeedFile = {
  relPath: 'a.txt',
  content: 'have one\n',
  headRev: 2,
  headContent: 'head two\n',
}
const behindToo: SeedFile = {
  relPath: 'src/lib/util.ts',
  content: 'have one\n',
  headRev: 2,
  headContent: 'head two\n',
}

/** The fake p4 stays silent this long before applying anything — the window the
 *  rate exists to fill, and the window both phases have to be observed inside.
 *  It has to outlast this spec's own step budget (~15s of polling on a healthy
 *  run, worst case ~90s if an assertion is about to fail) with room to spare:
 *  once p4 starts printing, `done` leaves 0 and a failed run would report a
 *  confusing mismatch instead of the real problem. */
const SILENT_START_MS = 35_000
/** Base sampler step, one tick a second. The probe grows the delta each tick
 *  (step × ticks), so the rate climbs and the width check below sees real
 *  movement rather than the same number three times. */
const IO_STEP_BYTES = 8 * 1024 * 1024
/** Tick at which the fake sampler switches to write-only deltas: ticks 1-3 move
 *  the read counter, tick 4 onward the write counter, so the read total stops at
 *  48MB and everything after it is write growth. */
const WRITE_FROM_TICK = 4

test.use({
  p4Seeds: { files: [behind, behindToo] },
  p4ExtraEnv: {
    UNIVERSE_P4_IO_PROBE: FAKE_IO_PROBE,
    UNIVERSE_P4_FAKE_IO_STEP: String(IO_STEP_BYTES),
    UNIVERSE_P4_FAKE_IO_WRITE_FROM_TICK: String(WRITE_FROM_TICK),
    UNIVERSE_P4_FAKE_SYNC_START_MS: String(SILENT_START_MS),
  },
})

/** The 7-character rate token the body carries, or null while it has none. */
const RATE = /(\d+)(KB|MB|GB|TB)\/s/
/** A non-zero rate: the whole point is that the token never sits at zero while
 *  p4 is working. */
const LIVE_RATE = /Syncing 0 · 0*[1-9]\d*(KB|MB|GB|TB)\/s/

test.describe('@p1 perforce sync I/O rate', () => {
  test('shows the rate through both phases and names the pulled revision @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(240_000)
    await evaluateWhenRestored(page)
    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    // The p4 status-bar entry: the client name plus its state, one button.
    const entry = page
      .locator('[data-testid="part-statusbar"] button')
      .filter({ hasText: 'Syncing' })

    /** The mantissa of the rate token the body is showing, or -1 while it has
     *  none. Used where only "is it moving" matters — not the exact figure, and
     *  not whether any file has landed yet. */
    const rateValue = async (): Promise<number> => {
      const token = RATE.exec((await entry.textContent()) ?? '')
      return token?.[1] !== undefined ? Number(token[1]) : -1
    }

    /** The two counters as the tooltip reports them, split. */
    const totals = async (): Promise<{ read: string | undefined; wrote: string | undefined }> => {
      const tip = (await entry.getAttribute('data-tooltip')) ?? ''
      const match = /read (\S+), wrote (\S+) \(/.exec(tip)
      return { read: match?.[1], wrote: match?.[2] }
    }

    await test.step('a non-zero rate appears before any file has been applied', async () => {
      // Fire and forget: awaiting the command would return only after the whole
      // get settles, i.e. after the window this step is about.
      await page.evaluate(() => void window.__E2E__!.runCommand('perforce.syncLatest'))
      // `done` still 0 (p4 has printed nothing) yet the body already moves: this
      // is the whole point of sampling the process instead of its output.
      await expect(entry).toHaveText(LIVE_RATE, { timeout: 30_000 })
      // The revision this run is pulling rides in the tooltip, so a user who
      // missed the completion notification can still answer for it.
      await expect(entry).toHaveAttribute('data-tooltip', /Target: the latest revision/)
    })

    await test.step('the rate token keeps its width while the number changes', async () => {
      const widths = new Set<number>()
      const seen = new Set<string>()
      for (let i = 0; i < 3; i++) {
        const text = (await entry.textContent()) ?? ''
        const token = RATE.exec(text)
        expect(token, `rate token in "${text}"`).not.toBeNull()
        widths.add(token![0].length)
        seen.add(token![0])
        await page.waitForTimeout(900)
      }
      // Three digits + a four-character unit, always — including across the
      // 8MB/s climb, which is what would move the entries beside it.
      expect([...widths]).toEqual([7])
      expect(seen.size).toBeGreaterThan(1)
    })

    await test.step('the rate survives the switch to the write-only phase', async () => {
      // Wait for the phase flip itself: the read counter stops while the write
      // counter keeps climbing. The wait is on the counters, not the clock, so a
      // slow machine narrows the margin instead of breaking the assertion.
      await expect
        .poll(
          async () => {
            const before = await totals()
            await page.waitForTimeout(2500)
            const after = await totals()
            return (
              before.read !== undefined && before.read === after.read && before.wrote !== after.wrote
            )
          },
          { timeout: 30_000, message: 'the sampler should have switched to write-only ticks' },
        )
        .toBe(true)

      // Let the read side stay frozen for longer than the 5s rate window: a
      // read-only rate has nothing left to difference against by now and reads a
      // flat `000KB/s`, which is the false "stalled" signal this readout exists
      // to remove — p4 is at its busiest here, landing the files. Only the
      // non-zero-ness is asserted: whether any file has landed yet is step 1's
      // business, and pinning it here would make a slow machine fail on the
      // assertion rather than on the behaviour.
      await page.waitForTimeout(3500)
      await expect.poll(rateValue, { timeout: 10_000 }).toBeGreaterThan(0)
    })

    await test.step('the entry names the last pull once the run is over', async () => {
      await expect(entry).toHaveCount(0, { timeout: 60_000 })
      // `lastSyncSpec` outlives the run on purpose: the notification is gone by
      // now, so the tooltip is the only place the target still lives.
      await expect(
        page.locator(
          '[data-testid="part-statusbar"] button[data-tooltip*="Last pull: the latest revision"]',
        ),
      ).toHaveCount(1)
    })
  })
})
