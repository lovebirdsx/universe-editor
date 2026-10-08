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
 *  Scan rounds are forced by moving the workspace FOCUS
 *  (`workspace.focusFolders`): the discovery range is `daily scope ∩ focus`, so a
 *  focus change re-arms the once-per-session scan AND changes the checkpoint
 *  fingerprint — the next round really spawns the engine instead of replaying a
 *  previous round's checkpoint. (A plain file change does not re-arm the scan at
 *  all: it is answered by a narrow per-file query.) Each round is synchronized on
 *  its OWN answer — the focused folder's row reappearing in the Changes group
 *  after the focus change dropped every row — rather than on a timer, because the
 *  settings file goes through one watcher and two writes close together can
 *  coalesce into a single change.
 *
 *  The workspace deliberately has NO `.p4delta-scope`: this file is about the RUN
 *  fallback, not about config layering, and an unconfigured workspace keeps every
 *  round's range equal to the opened folder. That leaves the focus changes below
 *  as the only thing deciding a round's shape — the range is resolved locally
 *  (the editor reads the same config file the engine would), so nothing here
 *  depends on the failing engine answering a scope question.
 *
 *  The second half of the file takes the other exit: `perforce.p4delta.enabled:
 *  false` must not even resolve the engine — with the fixture pointing
 *  `UNIVERSE_P4DELTA_PATH` at the fake, the δ argv log file must never come into
 *  existence.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateWhenRestored, mkTempDir } from '@universe-editor/e2e-harness'
import {
  readArgvLog,
  readScopeLog,
  test,
  expect,
  toPosix,
  waitForPerforceCommands,
} from '../fixtures/perforceApp.js'
import type { SeedFile } from '../fixtures/perforceApp.js'

const drifted: SeedFile = { relPath: 'drifted.txt', content: 'have revision\n' }
const clean: SeedFile = { relPath: 'clean.txt', content: 'untouched\n' }
/** Three folders that exist and hold drift: focusing one is an observable change
 *  (its row is republished by the new round, every other row is dropped), which
 *  is what serializes the scan rounds below. */
const exA: SeedFile = { relPath: 'exA/x.txt', content: 'in a\n' }
const exB: SeedFile = { relPath: 'exB/y.txt', content: 'in b\n' }
const exC: SeedFile = { relPath: 'exC/z.txt', content: 'in c\n' }
/** Drifted on disk: every one of these starts as uncollected drift. */
const DRIFTED_SEEDS: readonly SeedFile[] = [drifted, exA, exB, exC]
const driftOf = (seed: SeedFile): string => `edited on disk: ${seed.relPath}\n`
const DRIFTED_CONTENT = driftOf(drifted)

const fallbackDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const fallbackP4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')
const fallbackScopeLog = join(mkTempDir('ue2-p4delta-scope-'), 'scope.log')
const disabledDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const disabledP4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')

const deltaLines = (log: string): string[] => readArgvLog(log)
/** The δ SCAN spawns: the contract switches plus this round's directory target
 *  (the narrow per-file queries carry `--no-revert-groups` too but no `/...`). */
const deltaScanLines = (log: string): string[] =>
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
      UNIVERSE_P4DELTA_SCOPE_LOG: fallbackScopeLog,
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

    const groupIdsFor = (relPath: string) =>
      page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), relPath)

    await test.step('the drift still surfaces — natively — and the fallback is in the log', async () => {
      // Round 1 (unfocused) asked δ and got no summary. The same round then re-ran
      // the scan natively: the log of what the extension handed p4 is the only
      // place that shows it, because both engines would produce the same panel.
      await expect
        .poll(() => nativeScanLines(fallbackP4Log).length, {
          timeout: 60_000,
          message: 'the native engine should have re-run the scan in the same round',
        })
        .toBeGreaterThan(0)
      expect(deltaScanLines(fallbackDeltaLog).length).toBeGreaterThan(0)

      // The δ attempt really covered the workspace: the range it resolved is the
      // client root — a round that silently planned over nothing would fall back
      // for the wrong reason.
      await expect
        .poll(
          () =>
            readScopeLog(fallbackScopeLog)
              .flatMap((resolution) => resolution.includes)
              .map((entry) => toPosix(entry)),
          { timeout: 30_000, message: 'a δ round should have resolved the whole workspace' },
        )
        .toContain(`directory:${toPosix(perforce.clientRoot)}`)

      // The outcome: the drift is visible — group rows and the Explorer badge. A
      // build that read the summary-less stream as a conclusion would show neither.
      // Every drifted file is asserted, because the `ex*` folders' rows are what
      // the focus steps below watch being re-scanned.
      for (const seed of DRIFTED_SEEDS) {
        await expect
          .poll(() => groupIdsFor(seed.relPath), {
            timeout: 60_000,
            message: `${seed.relPath} should still reach the Changes group`,
          })
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
      /**
       * Move the focus and wait for THIS round's own answer: the focused folder's
       * row back in the Changes group, then the round's native end. The focus
       * change drops every row, so a row being in the group can only come from the
       * round that followed it.
       *
       * Deliberately NOT "did this round spawn δ": the log length can only be
       * read after the round is over, and a spawn still in flight from the
       * PREVIOUS round (its own settings write provokes a narrow query) lands in
       * that window under load — which attributes one round's engine to another
       * in either direction. The invariant is measured once, below, on a round
       * that starts from a settled log.
       *
       * Under this fault EVERY δ run fails, and they share one ladder — the scan
       * rounds below, and also the narrow per-file query each settings write
       * provokes for the settings file itself. So the ceiling is reached at some
       * round in the middle of this sequence; what the spec pins is the
       * invariant, not the round number.
       */
      const roundFromFocus = async (folder: string, focused: SeedFile): Promise<void> => {
        const nativeBefore = nativeScanLines(fallbackP4Log).length
        writeProjectSettings(perforce.clientRoot, {
          'workspace.focusEnabled': true,
          'workspace.focusFolders': { [folder]: true },
        })
        await expect
          .poll(() => groupIdsFor(focused.relPath), {
            timeout: 60_000,
            message: `focusing ${folder} should have re-scanned it (its row should come back)`,
          })
          .toContain('reconcile')
        await expect
          .poll(() => nativeScanLines(fallbackP4Log).length, {
            timeout: 60_000,
            message: `the round for ${folder} should have ended natively`,
          })
          .toBeGreaterThan(nativeBefore)
      }

      await roundFromFocus('exA', exA)
      await roundFromFocus('exB', exB)
      await roundFromFocus('exC', exC)

      // Round 1 already failed at this point, so the ladder's three consecutive
      // failures are covered — with the focus rounds or the narrow queries they
      // provoke. The engine really stopped: one more round spawns nothing at all,
      // not even for the settings file it just wrote. The log is sampled here,
      // with every earlier round settled on its own native end, so nothing in
      // flight can be mistaken for this round's spawn.
      expect(deltaLines(fallbackDeltaLog).length).toBeGreaterThanOrEqual(3)
      const deltaBefore = deltaLines(fallbackDeltaLog).length
      await roundFromFocus('exA', exA)
      expect(
        deltaLines(fallbackDeltaLog).length,
        'the round after the ceiling must not spawn δ',
      ).toBe(deltaBefore)
    })

    await test.step('a collect after the disarm is a native write, and the δ log stays frozen', async () => {
      const deltaBefore = deltaLines(fallbackDeltaLog).length
      // An explicit file-row collect (what the row's inline action runs) rather
      // than the group header: the row is a stable input for the one thing this
      // step must pin — the ENGINE the write lands on.
      await workbench.runCommand('perforce.reconcile', {
        resourceUri: perforce.file(drifted.relPath),
      })

      // The write went to p4 itself: a real collect (`-a`, no `-n`) naming this
      // file, with none of δ's switches anywhere in the line.
      await expect
        .poll(
          () =>
            readArgvLog(fallbackP4Log).filter(
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
        .poll(() => groupIdsFor(drifted.relPath), { timeout: 30_000 })
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

  test('perforce.p4delta.enabled: false never spawns the engine at all @regression', async ({
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
    // the native engine answered the scan and the drift is visible. The scan line
    // is polled, not read once — the row can be published by the narrow query a
    // file change provokes before the round's own directory scan is logged.
    await expect
      .poll(() => nativeScanLines(disabledP4Log).length, {
        timeout: 60_000,
        message: 'the native engine should have answered a scan',
      })
      .toBeGreaterThan(0)
    await expect
      .poll(
        () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), drifted.relPath),
        { timeout: 60_000, message: 'the native engine should have found the drift' },
      )
      .toContain('reconcile')

    // The negative half, in its strongest form: the δ argv log file was never
    // CREATED. A disabled engine must not even resolve its path, so nothing can
    // spawn it.
    expect(existsSync(disabledDeltaLog)).toBe(false)
    expect(deltaLines(disabledDeltaLog)).toEqual([])
  })
})
