/*---------------------------------------------------------------------------------------------
 *  The daily scope is a FILE, the focus only narrows the scan (@p1, @regression).
 *
 *  The layering this file pins, end to end and with the real wire (argv + the
 *  resolved range the engine logged):
 *    - `.p4delta-scope` decides the range: its directory is the include when it
 *      carries exclusions only, the excluded subtree is really walked out (its
 *      drift never reaches the Changes group even though it is on disk), and the
 *      config file excludes ITSELF;
 *    - the workspace FOCUS is an intersection applied on top — the scan's δ run
 *      resolves to the focused directory and the rows outside it leave the group;
 *    - …and nothing ELSE follows the focus: a plain get still runs over the whole
 *      DAILY scope, so a file outside the focus but inside the scope really lands
 *      on the server's revision. (The user's get must not follow what they happen
 *      to be looking at.)
 *
 *  The out-of-scope journey covers the other half of the same policy: a target
 *  the scope does not cover is never trimmed silently. The dialog offers the two
 *  real choices, and each is asserted with its consequence — "run as chosen" runs
 *  that one get with `--no-scope-file` (and really gets the file), "use the
 *  workspace scope" leaves the file alone and says so.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateWhenRestored, mkTempDir } from '@universe-editor/e2e-harness'
import {
  readArgvLog,
  readScopeLog,
  test,
  expect,
  toPosix,
  waitForPerforceCommands,
  writeScopeFile,
} from '../fixtures/perforceApp.js'
import type { SeedFile, ScopeResolution } from '../fixtures/perforceApp.js'

const HAVE = 'have revision\n'
const HEAD = 'head revision\n'

/** Drift inside the scope: the row that must appear. */
const inScope: SeedFile = { relPath: 'src/keep.txt', content: 'have keep\n' }
/** Behind head, NOT drifted: the plain get below is the only thing that moves it. */
const inScopeBehind: SeedFile = {
  relPath: 'src/behind.txt',
  content: HAVE,
  headRev: 2,
  headContent: HEAD,
}
/** Drift in the excluded subtree: on disk, never in the panel. */
const excludedDrift: SeedFile = { relPath: 'docs/skip.txt', content: 'have skip\n' }
/** Drift in the focused directory: its row comes back after the focus change. */
const focused: SeedFile = { relPath: 'sub/deep.txt', content: 'have deep\n' }

const DRIFT = 'edited on disk\n'

const layeringDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const layeringScopeLog = join(mkTempDir('ue2-p4delta-scope-'), 'scope.log')

/** Behind head and OUTSIDE the scope (`docs` is not covered): the target the two
 *  confirmation choices are about. */
const outOfScope: SeedFile = {
  relPath: 'docs/outside.txt',
  content: HAVE,
  headRev: 2,
  headContent: HEAD,
}
const outOfScopeSecond: SeedFile = {
  relPath: 'docs/other.txt',
  content: HAVE,
  headRev: 2,
  headContent: HEAD,
}

const confirmDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const confirmScopeLog = join(mkTempDir('ue2-p4delta-scope-'), 'scope.log')

const scopeLines = (log: string): ScopeResolution[] => readScopeLog(log)
/** The RANGE a run resolved to (`includes`): the caller names targets and the
 *  engine intersects them with the client root's config, so this is what the run
 *  actually worked over — `targets` would only say what was asked for. */
const entries = (resolution: ScopeResolution): string[] => resolution.includes.map(toPosix)

test.describe('@p1 perforce daily scope layering', () => {
  test.use({
    p4Seeds: { files: [inScope, inScopeBehind, excludedDrift, focused] },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: layeringDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: join(mkTempDir('ue2-p4-argv-'), 'p4.log'),
      UNIVERSE_P4DELTA_SCOPE_LOG: layeringScopeLog,
    },
  })

  test('the config file decides the range, the focus narrows the scan, and a plain get keeps the scope @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(180_000)
    await evaluateWhenRestored(page)

    for (const seed of [inScope, excludedDrift, focused]) {
      writeFileSync(perforce.file(seed.relPath), DRIFT, 'utf8')
    }
    // The config carries an EXCLUSION only: per the contract its own directory is
    // then the include, which is what makes `docs` an exclusion rather than a
    // path outside the range.
    writeScopeFile(perforce.clientRoot, undefined, ['docs'])
    // The settings file has to exist BEFORE the workspace opens: the config slot
    // installs its watcher on the directory that was there at activation, and the
    // focus change below arrives through that watcher.
    const settingsDir = join(perforce.clientRoot, '.universe-editor')
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(join(settingsDir, 'settings.json'), '{}', 'utf8')

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

    await test.step('the scan resolves the config: its directory in, the excluded subtree and the file itself out', async () => {
      await expect
        .poll(() => scopeLines(layeringScopeLog).flatMap((r) => r.includes.map(toPosix)), {
          timeout: 60_000,
          message: 'the scan should resolve the daily scope',
        })
        .toContain(`directory:${toPosix(perforce.clientRoot)}`)
      const resolution = scopeLines(layeringScopeLog).at(-1)!
      expect(resolution.excludes.map(toPosix)).toEqual(
        expect.arrayContaining([
          `directory:${toPosix(perforce.file('docs'))}`,
          // The config file excludes ITSELF: the scope is self-describing, and a
          // snapshot that left it in would report the file as drift on every run.
          `file:${toPosix(perforce.file('.p4delta-scope'))}`,
        ]),
      )
      expect(resolution.scopeFile).not.toBeNull()
    })

    await test.step('the excluded subtree is really walked out', async () => {
      await expect
        .poll(() => groupIdsFor(inScope.relPath), {
          timeout: 60_000,
          message: 'the in-scope drift should reach the Changes group',
        })
        .toContain('reconcile')
      await expect
        .poll(() => groupIdsFor(focused.relPath), {
          timeout: 60_000,
          message: 'the other in-scope drift should reach the Changes group',
        })
        .toContain('reconcile')
      // On disk but out of scope: no row, ever. A scan that ignored the config's
      // exclusion (or fell back to the raw workspace) would list it here.
      expect(await groupIdsFor(excludedDrift.relPath)).toEqual([])
    })

    await test.step('the focus narrows the scan to the intersection', async () => {
      writeFileSync(
        join(settingsDir, 'settings.json'),
        JSON.stringify({
          'workspace.focusEnabled': true,
          'workspace.focusFolders': { sub: true },
        }),
        'utf8',
      )

      // The engine was handed the INTERSECTION, as a typed target: the focus
      // directory, not the config's directory.
      await expect
        .poll(
          () =>
            scopeLines(layeringScopeLog)
              .flatMap((r) => entries(r))
              .filter((entry) => entry.startsWith('directory:')),
          { timeout: 60_000, message: 'the focused round should scan the intersection' },
        )
        .toContain(`directory:${toPosix(perforce.file('sub'))}`)

      // …and the rows follow the new range: the focus folder's row is re-published
      // by the round, everything outside it leaves the group.
      await expect
        .poll(() => groupIdsFor(focused.relPath), {
          timeout: 60_000,
          message: 'the focused round should re-publish its own row',
        })
        .toContain('reconcile')
      await expect
        .poll(() => groupIdsFor(inScope.relPath), {
          timeout: 60_000,
          message: 'a row outside the focus should leave the group',
        })
        .toEqual([])
    })

    await test.step('a plain get runs over the whole scope, not the focus', async () => {
      // No argument: the workspace-level get, whose range is the DAILY scope.
      await page.evaluate(() => void window.__E2E__!.runCommand('perforce.syncLatest'))

      await expect
        .poll(() => readFileSync(perforce.file(inScopeBehind.relPath), 'utf8'), {
          timeout: 60_000,
          message: 'the get should land the head revision of a file outside the focus',
        })
        .toBe(HEAD)

      // The shape of that get: the scope's own directory as the target. A get
      // that followed the focus would name `sub` here — and would not have
      // touched `src/behind.txt` at all.
      await expect
        .poll(
          () =>
            scopeLines(layeringScopeLog)
              .filter((r) => r.mode === 'sync')
              .flatMap((r) => entries(r)),
          { timeout: 30_000, message: 'the plain get should have run over the daily scope' },
        )
        .toContain(`directory:${toPosix(perforce.clientRoot)}`)
      expect(
        scopeLines(layeringScopeLog)
          .filter((r) => r.mode === 'sync')
          .flatMap((r) => entries(r)),
      ).not.toContain(`directory:${toPosix(perforce.file('sub'))}`)
    })

    // The get's scope was the config's, so the excluded subtree stayed out of it
    // too: `p4 sync` over the excluded directory would have widened the range the
    // user declared.
    expect(readArgvLog(layeringDeltaLog).filter((l) => l.includes('--no-scope-file'))).toEqual([])
  })
})

test.describe('@p1 perforce out-of-scope targets', () => {
  test.use({
    p4Seeds: { files: [inScope, outOfScope, outOfScopeSecond] },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: confirmDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: join(mkTempDir('ue2-p4-argv-'), 'p4.log'),
      UNIVERSE_P4DELTA_SCOPE_LOG: confirmScopeLog,
    },
  })

  test('the two choices really differ: run as chosen gets it, obeying the scope does not @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(180_000)
    await evaluateWhenRestored(page)

    // A scope that covers `src` only, so anything under `docs` is out of it.
    writeScopeFile(perforce.clientRoot, ['src'])

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    await test.step('run as chosen: the target is confirmed explicitly and really gets', async () => {
      void page
        .evaluate(
          (p) => void window.__E2E__!.runCommand('perforce.syncLatest', { resourceUri: p }),
          perforce.file(outOfScope.relPath),
        )
        .catch(() => {})

      // Nothing was trimmed silently: the user is told which paths the scope does
      // not cover, and chooses.
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await expect(dialog).toContainText('does not cover')
      await expect(dialog).toContainText('outside.txt')
      await dialog.getByRole('button', { name: 'Run as chosen' }).click()

      // The consequence, on the wire: this get ran with `--no-scope-file`, which
      // is the only expressible form of "the user explicitly chose a target the
      // daily scope does not cover".
      const overrideRuns = (): string[] =>
        readArgvLog(confirmDeltaLog).filter((l) => /(^| )--sync( |$)/.test(l))
      await expect
        .poll(() => overrideRuns().filter((l) => l.includes('--no-scope-file')).length, {
          timeout: 60_000,
          message: 'the confirmed get should run without the scope file',
        })
        .toBeGreaterThan(0)
      // …and it stays on that ONE run: the override is a property of the target
      // the user confirmed, never a mode. A scan round that inherited it would
      // lift the scope for every later operation in the session.
      expect(
        readArgvLog(confirmDeltaLog).filter(
          (l) => l.includes('--no-scope-file') && !/(^| )--sync( |$)/.test(l),
        ),
      ).toEqual([])

      // …and the range it ran over: the named file, with no config source.
      await expect
        .poll(
          () =>
            scopeLines(confirmScopeLog)
              .filter((r) => r.mode === 'sync' && r.scopeFile === null)
              .flatMap((r) => entries(r)),
          { timeout: 30_000, message: 'the override run should cover the named file' },
        )
        .toContain(`file:${toPosix(perforce.file(outOfScope.relPath))}`)

      // The user-visible half: the file is at head. A silently trimmed run would
      // have left it on the have revision and said nothing.
      await expect
        .poll(() => readFileSync(perforce.file(outOfScope.relPath), 'utf8'), {
          timeout: 30_000,
          message: 'the confirmed get should really write the head revision',
        })
        .toBe(HEAD)
      // …and the one thing the override must NOT do: widen the range to the
      // excluded subtrees nobody asked about. The sibling is untouched.
      expect(readFileSync(perforce.file(inScope.relPath), 'utf8')).toBe(inScope.content)
    })

    await test.step('use the workspace scope: the target is dropped, not silently run', async () => {
      const before = scopeLines(confirmScopeLog).length
      void page
        .evaluate(
          (p) => void window.__E2E__!.runCommand('perforce.syncLatest', { resourceUri: p }),
          perforce.file(outOfScopeSecond.relPath),
        )
        .catch(() => {})

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await dialog.getByRole('button', { name: 'Use the workspace scope' }).click()

      // Every named target was outside the scope, so there is nothing left to run:
      // the operation is NOT run, and the user is told why (an empty range is a
      // different operation, not a smaller one).
      await expect(
        page
          .locator('[data-testid="notification-toast-item"]')
          .filter({ hasText: 'outside the workspace scope' }),
      ).toBeVisible({ timeout: 30_000 })

      // The consequence on the wire and on disk: no δ run whatsoever for that
      // file…
      expect(
        scopeLines(confirmScopeLog)
          .slice(before)
          .flatMap((r) => entries(r)),
      ).not.toContain(`file:${toPosix(perforce.file(outOfScopeSecond.relPath))}`)
      // …and the draft is exactly where it was.
      expect(readFileSync(perforce.file(outOfScopeSecond.relPath), 'utf8')).toBe(HAVE)
    })
  })
})
