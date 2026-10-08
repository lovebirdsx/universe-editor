/*---------------------------------------------------------------------------------------------
 *  δ carries the two write operations it is allowed to take (@p1, @regression).
 *
 *  Reads are easy to fake convincingly: the panel would look the same if the
 *  engine were asked and its answer ignored. Writes are where the engine's own
 *  argv decides what happens to the user's disk, so each half asserts BOTH:
 *    - the shape of the call — the switch that makes it a write (`-a`), and the
 *      range the engine RESOLVED (read from its scope log: the argv names targets,
 *      and the range also depends on whatever `.p4delta-scope` the client root
 *      holds — the same file the editor read), and
 *    - the world after it (the file's opened state in the shared fake state file
 *      — the model `p4 opened` reads back — and the bytes on disk).
 *
 *  One workspace drives both: first a directory-scoped Clean on `sub` (the
 *  `revertReconcile` half of the folder revert), then a Collect of what is still
 *  drift, through the Changes group header. The row that must NOT be touched
 *  (`drifted.txt`, outside the cleaned directory) is re-asserted after each step.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs'
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
import type { SeedFile, ScopeResolution } from '../fixtures/perforceApp.js'

const drifted: SeedFile = { relPath: 'drifted.txt', content: 'have drifted\n' }
const inA: SeedFile = { relPath: 'sub/a.txt', content: 'have a\n' }
const inB: SeedFile = { relPath: 'sub/b.txt', content: 'have b\n' }

/** Drifted on disk only — never `p4 edit`-ed, so every row starts as uncollected drift. */
const drift = (seed: SeedFile): string => `drifted: ${seed.content}`

const deltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const p4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')
const scopeLog = join(mkTempDir('ue2-p4delta-scope-'), 'scope.log')

const deltaLines = (): string[] => readArgvLog(deltaLog)
const scopeLines = (): ScopeResolution[] => readScopeLog(scopeLog)
/** The RANGE a run resolved, in the same `<kind>:<path>` spelling the fake logs —
 *  compared separator-blind, since the extension hands paths in `/` spelling and
 *  the fixture's `file()` is platform spelling. {@link ScopeResolution.targets}
 *  would say what the caller NAMED; `includes` says what the engine actually
 *  worked over (the config can narrow or exclude it). */
const rangeOf = (resolution: ScopeResolution): string[] =>
  resolution.includes.map((entry) => toPosix(entry))

test.describe('@p1 perforce p4delta writes', () => {
  test.use({
    p4Seeds: { files: [drifted, inA, inB] },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: deltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: p4Log,
      UNIVERSE_P4DELTA_SCOPE_LOG: scopeLog,
    },
  })

  test('cleans a directory and collects the drift through δ, with p4 never asked @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    for (const seed of [drifted, inA, inB]) {
      writeFileSync(perforce.file(seed.relPath), drift(seed), 'utf8')
    }

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

    // All three rows are drift to begin with (δ's scan answer).
    for (const seed of [drifted, inA, inB]) {
      await expect
        .poll(() => groupIdsFor(seed.relPath), {
          timeout: 60_000,
          message: `${seed.relPath} should start out as drift`,
        })
        .toContain('reconcile')
    }

    await test.step('a directory Clean runs on δ as one --clean -a call and really restores the disk', async () => {
      // Drive the folder revert the way the Explorer context menu does: the
      // directory as both the primary arg and the (materialized) selection. It
      // blocks on its own confirm dialog, so fire-and-forget then click Revert —
      // awaiting the command here would deadlock the test.
      void page
        .evaluate(
          (args) =>
            void window.__E2E__!.runCommand(
              'perforce.revert',
              { resourceUri: args.uri, isDirectory: true },
              [{ resourceUri: args.uri, isDirectory: true }],
            ),
          { uri: perforce.file('sub') },
        )
        .catch(() => {})

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await expect(dialog).toContainText("Discard working-tree changes under 'sub'")
      await dialog.getByRole('button', { name: 'Revert' }).click()

      // The shape: a `--clean` write, as one call over the selected directory.
      // `-a` is what separates it from the preview variants, and there is no
      // `--no-scope-file`: the target is inside the daily scope, so the config
      // stays part of the run.
      await expect
        .poll(
          () =>
            deltaLines().filter(
              (l) =>
                l.includes('--clean') && /(^| )-a( |$)/.test(l) && !l.includes('--no-scope-file'),
            ).length,
          {
            timeout: 60_000,
            message: 'the clean should hand δ --clean -a over the selected directory',
          },
        )
        .toBeGreaterThan(0)

      // The range the clean ran over: the SELECTED DIRECTORY, as one directory
      // entry — the engine's own exclusion-aware walk, instead of a carved list
      // of files the editor guessed. And not the client root: a clean that
      // widened to the workspace would take the drift this spec keeps outside.
      await expect
        .poll(
          () =>
            scopeLines()
              .filter((r) => r.mode === 'clean')
              .flatMap((r) => rangeOf(r)),
          { timeout: 30_000, message: 'the clean should have resolved to the selected directory' },
        )
        .toContain(`directory:${toPosix(perforce.file('sub'))}`)
      expect(
        scopeLines()
          .filter((r) => r.mode === 'clean')
          .flatMap((r) => rangeOf(r)),
      ).not.toContain(`directory:${toPosix(perforce.clientRoot)}`)

      // The world after it: both files are back on their have revision on DISK
      // (`p4 clean` writes content, so a panel-only assertion would miss a run
      // that only dropped the rows).
      await expect
        .poll(() => readFileSync(perforce.file(inA.relPath), 'utf8'), {
          timeout: 30_000,
          message: 'a.txt should be restored to its have revision',
        })
        .toBe(inA.content)
      await expect
        .poll(() => readFileSync(perforce.file(inB.relPath), 'utf8'), {
          timeout: 30_000,
          message: 'b.txt should be restored to its have revision',
        })
        .toBe(inB.content)

      // …and the rows left the Changes group, while the file OUTSIDE the cleaned
      // directory still shows its drift (the clean was scoped, not global). That
      // last one is polled rather than read once: the two empty-group assertions
      // above are ALSO true in the window where the clean's own refresh has
      // cleared the group but not yet republished it, so a plain read there
      // samples that window and calls the surviving row a casualty.
      await expect.poll(() => groupIdsFor(inA.relPath), { timeout: 30_000 }).toEqual([])
      await expect.poll(() => groupIdsFor(inB.relPath), { timeout: 30_000 }).toEqual([])
      await expect
        .poll(() => groupIdsFor(drifted.relPath), {
          timeout: 30_000,
          message: 'the drift outside the cleaned directory should still be listed',
        })
        .toContain('reconcile')
    })

    await test.step('collecting through the Changes group header opens the file in δ', async () => {
      const before = deltaLines().length
      await workbench.runCommand('perforce.reconcile', { scmResourceGroupId: 'reconcile' })

      // The shape of the collect: `-a` over the drift row's own path, and no
      // `--clean` in sight.
      await expect
        .poll(
          () =>
            deltaLines()
              .slice(before)
              .filter((l) => /(^| )-a( |$)/.test(l) && !l.includes('--clean')).length,
          {
            timeout: 60_000,
            message: 'the collect should hand δ -a over the drift row',
          },
        )
        .toBeGreaterThan(0)

      // …and the resolved range really named the drift row: the group header
      // collects what the group SHOWS, as a per-file entry (a directory here
      // would mean the collect widened to a walk).
      await expect
        .poll(
          () =>
            scopeLines()
              .filter((r) => r.mode === 'open')
              .flatMap((r) => rangeOf(r)),
          { timeout: 30_000, message: 'the collect should have named the drift row' },
        )
        .toContain(`file:${toPosix(perforce.file(drifted.relPath))}`)

      // The world after it, read from the shared fake state: the file is now
      // OPENED for edit in the default changelist — the one thing "collected"
      // means, and the thing a toast would not prove.
      await expect
        .poll(
          () => {
            const state = JSON.parse(readFileSync(p4Workspace.stateFile, 'utf8')) as {
              opened?: Record<string, { action?: string; change?: string }>
            }
            return state.opened?.['//depot/drifted.txt']
          },
          { timeout: 30_000, message: 'the collect should really open the file for edit' },
        )
        .toEqual(expect.objectContaining({ action: 'edit', change: 'default' }))

      // …and the panel agrees: the row moved from Changes into the default
      // changelist group.
      await expect
        .poll(() => groupIdsFor(drifted.relPath), { timeout: 30_000 })
        .toEqual(['default'])
    })

    // Neither write ever fell back to the native engine. The log records every
    // `reconcile` the extension hands to p4 itself, and the two native shapes it
    // can carry are told apart by `-n`: a dry run (`reconcile -n -a -e -d …`) is
    // the scan batch and the narrow queries, an APPLY (`reconcile -a -e -d …`) is
    // the collect. A native Clean (`clean -a …`) is a different command and never
    // reaches this log at all — the `--clean -a` assertion above is what guards
    // that direction.
    //
    // So the predicate is "no apply", not "the log is empty": a narrow query
    // issued before the first scan round IS native by design — `_reconcileScanEngine`
    // starts at 'native' and only a proven scan round flips it (docs/reconcile.md)
    // — so an empty log held only while the δ verdict won the race against the
    // host's first `checkWorkingTree` batch. That race is not a property the
    // product has.
    const nativeApplies = readArgvLog(p4Log).filter((line) => !/(^| )-n( |$)/.test(line))
    expect(nativeApplies).toEqual([])
  })
})
