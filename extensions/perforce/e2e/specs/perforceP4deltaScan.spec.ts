/*---------------------------------------------------------------------------------------------
 *  The δ engine takes the drift scan end to end (@p1, @regression).
 *
 *  With `UNIVERSE_P4DELTA_PATH` pointed at the δ fake, opening a workspace that
 *  has drift on disk must:
 *    - answer the background reconcile scan with ONE `p4delta --json` call per
 *      scope round (the contract switches + this round's positional targets),
 *    - surface the drift where the user sees it: the Changes group row and the
 *      Explorer's RM badge,
 *    - and leave the native SCAN unasked: no line in the native argv log — the
 *      record of every `reconcile` the EXTENSION hands to p4 — describes a
 *      directory (`<dir>/...` or `<dir>/*`), which is the only evidence that no
 *      silent per-directory fallback ran. (Not "the log is empty": the narrow
 *      queries this spec provokes are per-file, and one of them IS native by
 *      design before the first scan round proves δ — see the assertion.)
 *
 *  Both engines write the SAME disk state (one shared fake state file), so the
 *  panel assertions alone could be satisfied by either one. Two logs tell them
 *  apart, and they answer different questions:
 *    - the argv log says WHICH CALLS were made (a directory target, never `-a` on
 *      a scan);
 *    - the scope log says WHAT RANGE each call resolved to — the caller names
 *      targets and the engine resolves them against the client root's config, and
 *      "the scan resolved to the client root" is exactly the claim the scope
 *      contract exists for.
 *  The "no native scan" half is asserted last, after every positive assertion has
 *  settled.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
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
/** Drift only: differs from the have revision, never `p4 edit`-ed. */
const DRIFTED_CONTENT = 'edited on disk\n'

const deltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const p4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')
const scopeLog = join(mkTempDir('ue2-p4delta-scope-'), 'scope.log')

test.describe('@p1 perforce p4delta scan', () => {
  test.use({
    p4Seeds: { files: [drifted, clean] },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: deltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: p4Log,
      UNIVERSE_P4DELTA_SCOPE_LOG: scopeLog,
    },
  })

  test('routes the drift scan to δ, shows the drift, and never scans with native @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    // Drift before the workspace opens, so the very first scan round sees it.
    writeFileSync(perforce.file(drifted.relPath), DRIFTED_CONTENT, 'utf8')

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    // The SCAN call: the contract switches the extension always spells plus the
    // DIRECTORY target this round was asked for. `-a` is what turns δ into a
    // write, so a scan carrying it would be opening the drift it was only asked to
    // report; `--no-scope-file` is reserved for an explicitly confirmed
    // out-of-scope operation — neither belongs on a plain scan. A directory target
    // is also what identifies the line: the narrow queries this spec provokes are
    // per-FILE (a file target has no `/...`).
    //
    // Paths below are compared separator-blind (`toPosix`): the extension hands
    // δ its local targets in `/` spelling (`pathUtil.norm`) while the fixture's
    // `clientRoot` / `file()` are platform spelling, so on Windows the same path
    // reads `E:/ws/x` in the log and `E:\ws\x` in the expectation. What these
    // assertions are about is WHICH path the engine was handed, not how it was
    // spelled. (The `--client-root` switch is passed through verbatim, hence its
    // own assertion stays exact.)
    await expect
      .poll(() => deltaLogLines().filter((l) => l.includes('/...')).length, {
        timeout: 60_000,
        message: 'the drift scan should ride δ over a directory target',
      })
      .toBeGreaterThan(0)
    const scanLine = deltaLogLines().find((l) => l.includes('/...'))!
    expect(scanLine).toContain('--json')
    expect(scanLine).toContain(`--client-root ${perforce.clientRoot}`)
    expect(scanLine).toContain('--no-revert-groups')
    expect(scanLine).not.toContain('--no-scope-file')
    expect(scanLine).not.toMatch(/(^| )-a( |$)/)
    // The range travels as a positional target: the engine resolves it against
    // whatever config the client root holds, which is the same file the editor
    // read — the two sides can never disagree about a copy.
    expect(scanLine).toContain(`${toPosix(perforce.clientRoot)}/...`)

    // …and the range that request resolved to: the workspace was opened with no
    // `.p4delta-scope`, so the daily scope is the whole opened folder — this is
    // the scan's own answer about what it walked, not an assumption.
    await expect
      .poll(
        () =>
          readScopeLog(scopeLog)
            .flatMap((resolution) => resolution.includes)
            .map((entry) => toPosix(entry)),
        { timeout: 30_000, message: 'the scan should have resolved the whole workspace' },
      )
      .toContain(`directory:${toPosix(perforce.clientRoot)}`)

    // The user-visible half — the drift reaches the Changes group (the scan's
    // answer) and the Explorer's RM badge (a narrow per-file query; under δ that
    // one rides the engine too, which the scope log proves below).
    await expect
      .poll(
        () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), drifted.relPath),
        { timeout: 60_000, message: 'the drifted file should land in the Changes group' },
      )
      .toContain('reconcile')

    let rearms = 0
    await expect
      .poll(
        async () => {
          const hint = await page.evaluate(
            (s) => window.__E2E__!.getScmWorkingTreeHintForResource(s),
            drifted.relPath,
          )
          // The hint channel caches, so a rewrite is what re-arms it after the
          // cold start raced the host's command registration. Bounded: past a few
          // nudges the remaining polls should observe, not keep writing.
          if (hint?.letter !== 'RM' && rearms < 5) {
            rearms++
            writeFileSync(perforce.file(drifted.relPath), DRIFTED_CONTENT, 'utf8')
          }
          return hint
        },
        { timeout: 60_000, intervals: [500, 1000] },
      )
      .toEqual(expect.objectContaining({ letter: 'RM' }))

    // The narrow query that answers the hint goes through δ as well, and as a
    // per-FILE range: a directory entry there would mean the batch was widened
    // into a walk, and the batch's paths are exactly what the round resolves to
    // (the file targets it was handed).
    await expect
      .poll(
        () =>
          readScopeLog(scopeLog).filter((resolution) =>
            resolution.includes
              .map((entry) => toPosix(entry))
              .includes(`file:${toPosix(perforce.file(drifted.relPath))}`),
          ).length,
        {
          timeout: 30_000,
          message: 'the narrow per-file query for the hint should ride δ too',
        },
      )
      .toBeGreaterThan(0)

    // The clean sibling must NOT be in the group: a scan that reported everything
    // would satisfy the positive assertion above on its own.
    expect(
      await page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), clean.relPath),
    ).toEqual([])

    // Finally the negative half: the drift SCAN never fell back to native. A
    // native scan walks the scope directory by directory, so its argv carries a
    // recursive `<dir>/...` (or a carved `<dir>/*`) spec — and every narrow query
    // THIS spec provokes is per-file (a seeded file is rewritten, the Explorer
    // hint asks about single files), so a directory spec here can only be the
    // scan.
    //
    // Deliberately not "the log is empty": a narrow query issued before the first
    // scan round IS native by design — `_reconcileScanEngine` starts at 'native'
    // and only a proven scan round flips it (docs/reconcile.md) — so an empty log
    // held only while the δ verdict happened to win the race against the first
    // per-file query. That race is not a property the product has.
    const nativeScans = readArgvLog(p4Log).filter(
      (line) => line.includes('/...') || line.includes('/*'),
    )
    expect(nativeScans).toEqual([])
  })
})

/** The δ fake's argv log, one full argv per line ('' before the first spawn). */
function deltaLogLines(): string[] {
  return readArgvLog(deltaLog)
}
