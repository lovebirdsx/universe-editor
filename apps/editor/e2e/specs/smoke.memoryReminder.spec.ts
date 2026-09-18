/*---------------------------------------------------------------------------------------------
 *  The memory reminder (P1): from a high heap to an armed diagnosis, through the real UI.
 *
 *  Ten minutes above the elevated line is the feature, so the spec cannot wait for it and
 *  cannot fake the heap either — the watermark reads a live renderer's `performance.memory`
 *  and has no setter. What IS real here: the policy, the toast the user actually clicks,
 *  the command behind the button, the reload, and the round main arms for the renderer that
 *  comes back. Only the readings are replayed, and each of these assertions is about
 *  something a fake cannot establish:
 *
 *    - the reminder reaches the screen at all (an IPC hop and a notification service)
 *    - its buttons carry the labels the sentence promises, and the main one is first
 *    - clicking it really reloads this window and really leaves a round armed — the
 *      one-shot intent in sessionStorage survives the reload, and nothing else does
 *    - an ordinary reload leaves nothing armed, i.e. the intent is not a persisted flag
 *      that any future start of the editor would find
 *
 *  Timing is deliberately not asserted: the baseline itself takes ~90s of arm age plus
 *  stable samples, which is `smoke.heapSnapshot.spec.ts`'s job to wait out.
 *--------------------------------------------------------------------------------------------*/

import { waitForProbe } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/electronApp.js'

/** Every two minutes: closer together than the observation-gap, so the stretch is real. */
const HIGH_EVERY_MS = 120_000

/** Two minutes short of the ten the policy asks for. */
const BRIEF_SERIES = [
  { afterMs: 0, level: 'elevated', usedBytes: 1_700_000_000 },
  { afterMs: HIGH_EVERY_MS, level: 'elevated', usedBytes: 1_800_000_000 },
  { afterMs: 2 * HIGH_EVERY_MS, level: 'elevated', usedBytes: 1_850_000_000 },
  { afterMs: 3 * HIGH_EVERY_MS, level: 'elevated', usedBytes: 1_900_000_000 },
]

const SUSTAINED_SERIES = [
  ...BRIEF_SERIES,
  { afterMs: 4 * HIGH_EVERY_MS, level: 'elevated', usedBytes: 1_950_000_000 },
  { afterMs: 5 * HIGH_EVERY_MS, level: 'elevated', usedBytes: 2_000_000_000 },
]

const RELOAD_ACTION = 'Reload and Start Diagnosis'

test.describe('@p1 memory reminder', () => {
  test('offers reload-and-diagnose, and the reload arms a round', async ({ page }) => {
    test.setTimeout(180_000)

    await page.evaluate((series) => window.__E2E__!.driveMemoryReminder(series), SUSTAINED_SERIES)

    const toast = page.getByTestId('notification-toast-item').filter({ hasText: RELOAD_ACTION })
    await expect(toast).toBeVisible()
    // The sentence is the consent for everything the main action does — there is no dialog
    // behind the button, so what the user reads here is all they get. Both costs have to be
    // in it, and both have to survive the toast's ~5-line cap: they are checked on what the
    // user can actually see, not on what was passed to notify().
    const text = (await toast.textContent()) ?? ''
    expect(text).toContain('has not brought it down')
    expect(text).toContain('discards unsaved changes')
    expect(text).toMatch(/up to about \d+ seconds/)
    expect(text).toContain('never uploaded automatically')
    expect(text).not.toContain('\n')
    const decisions = await page.evaluate(() => window.__E2E__!.getMemoryReminderDecisions())
    expect(decisions.at(-1)).toMatchObject({ remind: true, reason: 'remind' })

    // Arm the load listener before clicking: the reload is IPC-async, and
    // `waitForRestartRestore` would send its own reload instead of this one.
    const loaded = page.waitForEvent('load')
    await toast.getByRole('button', { name: RELOAD_ACTION }).click()
    await loaded
    await waitForProbe(page)

    // The renderer that came back consumed the intent, so a round is armed for it. Main
    // measures the round against the new renderer's own epoch, which is the whole point
    // of reloading first: the baseline is taken on a heap that just started.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getHeapSnapshotStatus()), { timeout: 30_000 })
      .toMatchObject({ active: true })

    // The reminder is gone: it belonged to the window that was replaced. Asserted on the
    // action label rather than the message, because a button is the part that could come
    // back wrong — a restored notification keeps its text but loses its handlers.
    const restored = await page.evaluate(() => window.__E2E__!.getNotifications())
    expect(restored.some((entry) => entry.actions.includes(RELOAD_ACTION))).toBe(false)
  })

  test('raises no reminder for a series that never reaches the threshold', async ({ page }) => {
    await page.evaluate((series) => window.__E2E__!.driveMemoryReminder(series), BRIEF_SERIES)

    const decisions = await page.evaluate(() => window.__E2E__!.getMemoryReminderDecisions())
    expect(decisions.at(-1)).toMatchObject({ remind: false, reason: 'too-brief' })
    expect(await page.evaluate(() => window.__E2E__!.getMemoryReminderState())).toMatchObject({
      reminded: false,
    })
    expect(
      await page.evaluate(() => window.__E2E__!.getNotifications().map((entry) => entry.message)),
    ).toEqual([])
  })

  test('an ordinary reload leaves no round armed', async ({ page, workbench }) => {
    test.setTimeout(120_000)

    // No reminder, no intent — the reload a user does for any other reason must not start
    // a diagnosis. If the intent were ever moved to a persisted store, this is where it
    // would show up.
    await workbench.waitForRestartRestore()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getHeapSnapshotStatus()), { timeout: 30_000 })
      .toMatchObject({ active: false })

    // The command on its own does arm one, so the assertion above is about the intent
    // rather than about a round that could never have started here.
    const loaded = page.waitForEvent('load')
    void page
      .evaluate(
        () => void window.__E2E__!.runCommand('workbench.action.reloadWindowForMemoryDiagnosis'),
      )
      .catch(() => {})
    await loaded
    await waitForProbe(page)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getHeapSnapshotStatus()), { timeout: 30_000 })
      .toMatchObject({ active: true })
  })
})
