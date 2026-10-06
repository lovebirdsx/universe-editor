/*---------------------------------------------------------------------------------------------
 *  δ degrading safely: a run that concludes nothing, and the disarmed engine
 *  (@p1, @regression).
 *
 *  Hard rule 1 of the contract: only a `kind:"summary"` record proves anything.
 *  The `nosummary` fault produces a stream that LOOKS complete — records, exit 0
 *  — and stops one record short of a conclusion. Two things must follow, and the
 *  spec pins both:
 *    - the same round still answers, natively: the drift reaches the panel and the
 *      Explorer badge, so a broken engine costs a slow scan, never a missing one;
 *      the native argv log is the proof the fallback actually ran (a build that
 *      read the partial stream as an answer would never log one).
 *    - the ladder: after `P4DELTA_MAX_CONSECUTIVE_FAILURES` (3) failed rounds the
 *      engine is disarmed for the session — the next round does not spawn it at
 *      all, and a collect, which would otherwise be a δ write, goes native too.
 *
 *  Scan rounds are forced through `perforce.reconcile.excludeFolders` — the one
 *  config change that re-arms the once-per-session scan (a plain file change is
 *  answered by a narrow query instead). Each value excludes one more REAL folder
 *  of drifted files, so every write has an observable effect to synchronize on
 *  (that folder's row leaving the Changes group) rather than a timer: the
 *  settings file is read through one watcher, and two writes close together can
 *  otherwise coalesce into a single change.
 *
 *  The second half of the file takes the other exit: `perforce.p4delta.enabled:
 *  false` must not even PROBE the engine — with the fixture pointing
 *  `UNIVERSE_P4DELTA_PATH` at the fake, the δ argv log file must never come into
 *  existence.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateWhenRestored, mkTempDir } from '@universe-editor/e2e-harness'
import { readArgvLog, test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import type { SeedFile } from '../fixtures/perforceApp.js'

const drifted: SeedFile = { relPath: 'drifted.txt', content: 'have revision\n' }
const clean: SeedFile = { relPath: 'clean.txt', content: 'untouched\n' }
/** Three folders that exist and hold drift: excluding one is an observable
 *  config change (its row leaves the Changes group), which is what serializes
 *  the scan rounds below. */
const exA: SeedFile = { relPath: 'exA/x.txt', content: 'in a\n' }
const exB: SeedFile = { relPath: 'exB/y.txt', content: 'in b\n' }
const exC: SeedFile = { relPath: 'exC/z.txt', content: 'in c\n' }
/** Drifted on disk: every one of these starts as uncollected drift. */
const DRIFTED_SEEDS: readonly SeedFile[] = [drifted, exA, exB, exC]
const driftOf = (seed: SeedFile): string => `edited on disk: ${seed.relPath}\n`
const DRIFTED_CONTENT = driftOf(drifted)

const fallbackDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const fallbackP4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')
const disabledDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const disabledP4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')

const deltaLines = (log: string): string[] => readArgvLog(log)
/** The δ SCAN spawns: the contract switches plus a recursive scope entry. The
 *  `--version` probe and any per-file narrow query do not match. */
const scanLines = (log: string): string[] =>
  deltaLines(log).filter((l) => l.includes('--no-revert-groups') && l.includes('/...'))
/** Native `reconcile -n` lines: the log the extension writes when IT asks p4. */
const nativeScanLines = (log: string): string[] =>
  deltaLines(log).filter((l) => l.includes('reconcile') && /(^| )-n( |$)/.test(l))

/** Rewrite the project settings file. Written BEFORE the workspace opens in the
 *  disabled case (the watcher only exists for a directory that was there at
 *  install time) and repeatedly after it in the disarm case. */
function writeProjectSettings(clientRoot: string, settings: Record<string, unknown>): void {
  const dir = join(clientRoot, '.universe-editor')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf8')
}

test.describe('@p1 perforce p4delta fallback', () => {
  test.use({
    p4Seeds: { files: [drifted, clean, exA, exB, exC] },
    p4delta: { fail: 'nosummary' },
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: fallbackDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: fallbackP4Log,
    },
  })

  test('a summary-less run falls back natively in the same round, and 3 failures disarm the engine @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    test.setTimeout(180_000)
    await evaluateWhenRestored(page)

    for (const seed of DRIFTED_SEEDS) {
      writeFileSync(perforce.file(seed.relPath), driftOf(seed), 'utf8')
    }
    // A settings file has to exist before the workspace opens for the project
    // slot to install its watcher on the directory; its values are changed later.
    writeProjectSettings(perforce.clientRoot, {})

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    await test.step('the drift still surfaces — natively — and the fallback is in the log', async () => {
      // Round 1 asked δ (and got no summary). The same round then re-ran the scan
      // natively: the log of what the extension handed p4 is the only place that
      // shows it, because both engines would produce the same panel.
      await expect
        .poll(() => nativeScanLines(fallbackP4Log).length, {
          timeout: 60_000,
          message: 'the native engine should have re-run the scan in the same round',
        })
        .toBeGreaterThan(0)
      expect(deltaLines(fallbackDeltaLog).length).toBeGreaterThan(0)

      // The outcome: the drift is visible — group rows and the Explorer badge. A
      // build that read the summary-less stream as a conclusion would show neither.
      // Every drifted file is asserted, because the `ex*` folders' rows are what
      // the exclusion steps below watch leave the group.
      for (const seed of DRIFTED_SEEDS) {
        await expect
          .poll(
            () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), seed.relPath),
            { timeout: 60_000, message: `${seed.relPath} should still reach the Changes group` },
          )
          .toContain('reconcile')
      }

      let rearms = 0
      await expect
        .poll(
          async () => {
            const hint = await page.evaluate(
              (s) => window.__E2E__!.getScmWorkingTreeHintForResource(s),
              drifted.relPath,
            )
            if (hint?.letter !== 'RM' && rearms < 5) {
              rearms++
              writeFileSync(perforce.file(drifted.relPath), DRIFTED_CONTENT, 'utf8')
            }
            return hint
          },
          { timeout: 60_000, intervals: [500, 1000] },
        )
        .toEqual(expect.objectContaining({ letter: 'RM' }))
    })

    await test.step('three failed rounds disarm the engine; the next round does not spawn it', async () => {
      const groupIdsFor = (relPath: string) =>
        page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), relPath)

      // Each config change is synchronized on its OBSERVABLE effect — the newly
      // excluded folder's row leaving the Changes group — before the next write
      // goes out. The settings file is read through one watcher, so two writes
      // close together can coalesce into a single change; observing the effect
      // keeps the changes (and the scan rounds they trigger) serialized instead of
      // silently collapsing into one.
      const excludeAndSettle = async (dirs: readonly string[], gone: string) => {
        writeProjectSettings(perforce.clientRoot, {
          'perforce.reconcile.excludeFolders': [...dirs],
        })
        await expect
          .poll(() => groupIdsFor(gone), {
            timeout: 60_000,
            message: `excluding ${gone} should have taken effect (the row should leave the group)`,
          })
          .toEqual([])
      }
      // Every round under this fault ends in the native fallback, so "the log has
      // not moved for a while" means no round is in flight any more.
      const quiet = (ms = 500) =>
        expect
          .poll(
            async () => {
              const delta = deltaLines(fallbackDeltaLog).length
              const native = nativeScanLines(fallbackP4Log).length
              await new Promise((resolve) => setTimeout(resolve, ms))
              return (
                deltaLines(fallbackDeltaLog).length === delta &&
                nativeScanLines(fallbackP4Log).length === native
              )
            },
            { timeout: 60_000, intervals: [500] },
          )
          .toBe(true)

      // Round 1 already failed at this point; two more resets reach the ceiling
      // of 3 (each reset is one round, and under this fault every round fails).
      await excludeAndSettle(['exA'], exA.relPath)
      await excludeAndSettle(['exA', 'exB'], exB.relPath)
      await excludeAndSettle(['exA', 'exB', 'exC'], exC.relPath)

      // The ladder tripped: the engine was attempted at least three times and
      // then stopped — further resets add no δ spawns (they answer natively).
      await expect
        .poll(() => scanLines(fallbackDeltaLog).length, {
          timeout: 60_000,
          message: 'the engine should have been attempted at least 3 times',
        })
        .toBeGreaterThanOrEqual(3)
      await quiet()

      const deltaBefore = deltaLines(fallbackDeltaLog).length
      const nativeBefore = nativeScanLines(fallbackP4Log).length
      writeProjectSettings(perforce.clientRoot, {
        'perforce.reconcile.excludeFolders': ['exA', 'exB', 'exC', 'no-such-d'],
      })
      await expect
        .poll(() => nativeScanLines(fallbackP4Log).length, {
          timeout: 60_000,
          message: 'the disarmed round should still answer natively',
        })
        .toBeGreaterThan(nativeBefore)
      // …and the engine was not even spawned: the δ log is exactly as long as it
      // was before the round — no probe, no scan.
      expect(deltaLines(fallbackDeltaLog).length).toBe(deltaBefore)
    })

    await test.step('a collect after the disarm is a native write, and the δ log stays frozen', async () => {
      const deltaBefore = deltaLines(fallbackDeltaLog).length
      // An explicit file-row collect (what the row's inline action runs) rather
      // than the group header: the row is a stable input for the one thing this
      // step must pin — the ENGINE the write lands on. (The group header used to
      // be avoided because "an excludeFolders change drops the drift rows of
      // files sitting directly at the client ROOT". That was the fake not
      // understanding the carve's `<dir>/*` level spec — it matched no file, so a
      // carved level lost exactly its direct children — never product behaviour;
      // `targetsFromArgs` in fixtures/fake-p4.mjs now reads that spec, and
      // perforceDirectoryRevert.spec.ts pins the level's files surviving a carve.)
      await workbench.runCommand('perforce.reconcile', {
        resourceUri: perforce.file(drifted.relPath),
      })

      // The write went to p4 itself: a real collect (`-a`, no `-n`) naming this
      // file, with none of δ's switches anywhere in the line.
      await expect
        .poll(
          () =>
            deltaLines(fallbackP4Log).filter(
              (l) =>
                l.includes('reconcile') &&
                !l.includes(' -n ') &&
                /(^| )-a( |$)/.test(l) &&
                l.includes(drifted.relPath),
            ).length,
          { timeout: 60_000, message: 'the collect should have run on the native engine' },
        )
        .toBeGreaterThan(0)

      // The world: the file is really opened (read from the shared fake state,
      // which records what p4 was told) and the row moved to the changelist group.
      await expect
        .poll(
          () => {
            const state = JSON.parse(readFileSync(p4Workspace.stateFile, 'utf8')) as {
              opened?: Record<string, { action?: string }>
            }
            return state.opened?.['//depot/drifted.txt']?.action
          },
          { timeout: 30_000, message: 'the native collect should really open the file' },
        )
        .toBe('edit')
      await expect
        .poll(
          () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), drifted.relPath),
          { timeout: 30_000 },
        )
        .toEqual(['default'])

      // δ was not consulted for the write: the engine is disarmed, and the log
      // proves nothing was spawned behind the scenes.
      expect(deltaLines(fallbackDeltaLog).length).toBe(deltaBefore)
    })
  })
})

test.describe('@p1 perforce p4delta disabled', () => {
  test.use({
    p4Seeds: { files: [drifted, clean] },
    // The fixture hands the extension a δ binary anyway — the setting must win.
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: disabledDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: disabledP4Log,
    },
  })

  test('perforce.p4delta.enabled: false never spawns the engine, not even to probe it @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    writeProjectSettings(perforce.clientRoot, { 'perforce.p4delta.enabled': false })
    writeFileSync(perforce.file(drifted.relPath), DRIFTED_CONTENT, 'utf8')

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    // Liveness first, so a workspace that never came up cannot pass this spec:
    // the native engine answered the scan and the drift is visible.
    await expect
      .poll(
        () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), drifted.relPath),
        { timeout: 60_000, message: 'the native engine should have found the drift' },
      )
      .toContain('reconcile')
    expect(nativeScanLines(disabledP4Log).length).toBeGreaterThan(0)

    // The negative half, in its strongest form: the δ argv log file was never
    // CREATED. A disabled engine must not resolve the path, let alone spawn the
    // `--version` probe (which is the first thing an enabled session does).
    expect(existsSync(disabledDeltaLog)).toBe(false)
    expect(deltaLines(disabledDeltaLog)).toEqual([])
  })
})
