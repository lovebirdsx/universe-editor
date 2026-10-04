/*---------------------------------------------------------------------------------------------
 *  The δ engine takes the drift scan end to end (@p1, @regression).
 *
 *  With `UNIVERSE_P4DELTA_PATH` pointed at the δ fake, opening a workspace that
 *  has drift on disk must:
 *    - admit the engine through its `--help` probe,
 *    - answer the background reconcile scan with ONE `p4delta --json` call per
 *      scope round (the contract switches + the scope entries after `--`),
 *    - surface the drift where the user sees it: the Changes group row and the
 *      Explorer's RM badge,
 *    - and leave the native engine completely unasked: the native argv log — the
 *      record of every `reconcile` the EXTENSION hands to p4 — stays empty, which
 *      is the only evidence that no silent per-directory fallback ran.
 *
 *  Both engines write the SAME disk state (one shared fake state file), so the
 *  panel assertions alone could be satisfied by either one. The logs are what
 *  tell them apart, and the "native never ran" half is asserted last, after every
 *  positive assertion has settled.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateWhenRestored, mkTempDir } from '@universe-editor/e2e-harness'
import { readArgvLog, test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import type { SeedFile } from '../fixtures/perforceApp.js'

const drifted: SeedFile = { relPath: 'drifted.txt', content: 'have revision\n' }
const clean: SeedFile = { relPath: 'clean.txt', content: 'untouched\n' }
/** Drift only: differs from the have revision, never `p4 edit`-ed. */
const DRIFTED_CONTENT = 'edited on disk\n'

const deltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const p4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')

test.describe('@p1 perforce p4delta scan', () => {
  test.use({
    p4Seeds: { files: [drifted, clean] },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: deltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: p4Log,
    },
  })

  test('routes the drift scan to δ, shows the drift, and never spawns native reconcile @regression', async ({
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

    // The engine had to be admitted first: the probe is the only `--help` spawn.
    await expect
      .poll(() => deltaLogLines().filter((l) => l === '--help').length, {
        timeout: 30_000,
        message: 'the δ engine should have been probed with --help before use',
      })
      .toBe(1)

    // The SCAN call: the contract switches the extension always spells, the client
    // root (the round-trip saver), and the scope as a recursive entry after `--`.
    // A recursive entry is what distinguishes it from the per-file narrow query a
    // hint check issues — both otherwise carry the same switches.
    const scopeEntry = `${perforce.clientRoot}/...`
    await expect
      .poll(
        () =>
          deltaLogLines().filter(
            (l) => l.includes('--no-revert-groups') && l.split(' -- ').at(-1) === scopeEntry,
          ).length,
        {
          timeout: 60_000,
          message: `the scan should hand δ the whole scope: ${scopeEntry}`,
        },
      )
      .toBeGreaterThan(0)

    const scanLine = deltaLogLines().find(
      (l) => l.includes('--no-revert-groups') && l.split(' -- ').at(-1) === scopeEntry,
    )!
    expect(scanLine).toContain('--json')
    expect(scanLine).toContain('--no-scope-file')
    expect(scanLine).toContain(`--client-root ${perforce.clientRoot}`)
    // A scan is a PREVIEW: `-a` is what turns δ into a write, and a scan that
    // carried it would be opening the drift it was only asked to report.
    expect(scanLine).not.toMatch(/(^| )-a( |$)/)

    // The user-visible half — the drift reaches the Changes group (the scan's
    // answer) and the Explorer's RM badge (a narrow per-file query; under δ that
    // one rides the engine too, which the log proves below).
    await expect
      .poll(
        () =>
          page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), drifted.relPath),
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

    // The narrow query that answers the hint goes through δ as well: a per-file
    // entry (the bare path, no `/...`), never `-a`.
    await expect
      .poll(
        () =>
          deltaLogLines().filter(
            (l) => l.includes(perforce.file(drifted.relPath)) && !l.includes('/...'),
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

    // Finally the negative half: no native reconcile ran anywhere in this session
    // — not the scan, not the narrow query. A single fallback would have logged a
    // line here, so an empty log is the proof that δ carried the whole round.
    expect(readArgvLog(p4Log)).toEqual([])
  })
})

/** The δ fake's argv log, one full argv per line ('' before the first spawn). */
function deltaLogLines(): string[] {
  return readArgvLog(deltaLog)
}
