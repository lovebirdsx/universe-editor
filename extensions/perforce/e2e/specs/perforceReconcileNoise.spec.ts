/*---------------------------------------------------------------------------------------------
 *  The reconcile NOISE layer: `perforce.reconcile.excludeFolders` (@p1, @regression).
 *
 *  The setting is a NOISE rule, not a range source, and the whole point of the
 *  split is that the two answer different questions. Each journey here asserts
 *  both halves on the wire and on the world, never on the panel alone:
 *
 *    - ONE folder (`gen`) is hidden from the reconcile machinery: the scan's δ
 *      request carries it as a typed exclusion (the scope log names the range
 *      that actually ran), the drift inside it never becomes a row, and a batch
 *      collect over a parent that CONTAINS it — the workspace root, explicitly
 *      selected — leaves the hidden subtree alone (the shared fake state's
 *      `opened` map, which is what `p4 opened` would answer, plus the bytes on
 *      disk);
 *    - …while a plain get runs with the noise applied by nobody: the behind-head
 *      file INSIDE `gen` really lands on its head revision (content + haveRev),
 *      and the sync round's own logged range has no exclusion in it;
 *    - a clean over a parent carves around the hidden subtree instead of naming
 *      it (the clean's logged range), and the drift inside survives;
 *    - a target the user names DIRECTLY inside the hidden subtree is put to them
 *      ("Skip them" / "Run as chosen"), and each answer has a different
 *      consequence: skipping writes nothing at all, running as chosen collects
 *      exactly the named file (not its directory);
 *    - the scope, the focus and the noise are three independent layers: a scan
 *      resolves `scope ∩ focus − noise`, and the get that follows resolves the
 *      scope alone;
 *    - and when δ cannot conclude (summary-less run), the SAME-ROUND native
 *      fallback does not widen: its argv never names the hidden subtree, and
 *      never falls back to the whole-workspace `<root>/...` spec either.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { evaluateWhenRestored, mkTempDir } from '@universe-editor/e2e-harness'
import {
  readArgvLog,
  readHaveRev,
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
const DRIFT = 'edited on disk\n'

/** The top of the workspace: selected EXPLICITLY for the batch collect below, so
 *  it is a target that CONTAINS the hidden subtree (not a target the discovery
 *  already pruned). */
const rootTarget = (clientRoot: string): { resourceUri: string; isDirectory: boolean } => ({
  resourceUri: clientRoot,
  isDirectory: true,
})

/** Rewrite the project settings file. Written BEFORE the workspace opens: the
 *  activation-time read is what applies it, and a later edit would come through
 *  the config watcher (a different path, exercised where a journey needs it). */
function writeProjectSettings(clientRoot: string, settings: Record<string, unknown>): void {
  const dir = join(clientRoot, '.universe-editor')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf8')
}

const scopeLines = (log: string): ScopeResolution[] => readScopeLog(log)
const entriesOf = (r: ScopeResolution): string[] => r.includes.map(toPosix)
const excludesOf = (r: ScopeResolution): string[] => r.excludes.map(toPosix)
/** The targets a REPORT round trip was ASKED about (vs the range it resolved). */
const askedFor = (r: ScopeResolution): string[] => r.targets.map(toPosix)

/** The client's opened set, read from the shared fake state file — the model the
 *  native `p4 opened` answers from, so "collected" is asserted where it means
 *  something rather than in a toast. */
function openedOf(stateFile: string): Record<string, unknown> {
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
    opened?: Record<string, unknown>
  }
  return state.opened ?? {}
}

/** `v scmResourceGroupId` for one path, as the SCM panel sees it. */
const groupIdsFactory =
  (page: Page) =>
  (relPath: string): Promise<readonly string[]> =>
    page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), relPath)

const inScopeDrift: SeedFile = { relPath: 'src/keep.txt', content: HAVE }
/** Hidden drift: on disk, inside the noise folder, never a row. */
const hiddenDrift: SeedFile = { relPath: 'gen/skip.txt', content: HAVE }
/** Behind head, inside the noise folder: only the plain get below moves it. */
const hiddenBehind: SeedFile & { headRev: number } = {
  relPath: 'gen/behind.txt',
  content: HAVE,
  headRev: 2,
  headContent: HEAD,
}

/** The have revision the fake's own reader would report, for a seed whose head
 *  is ahead of its have: an entry synced TO head drops `haveRev` (head == have is
 *  its plain shape, read back as `haveRev ?? rev`), so an absent field there
 *  MEANS head — never "no revision". */
const haveRevOrHead = (stateFile: string, seed: { relPath: string; headRev: number }): number =>
  readHaveRev(stateFile, seed.relPath) ?? seed.headRev

const noiseDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const noiseP4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')
const noiseScopeLog = join(mkTempDir('ue2-p4delta-scope-'), 'scope.log')

test.describe('@p1 perforce reconcile noise', () => {
  test.use({
    p4Seeds: { files: [inScopeDrift, hiddenDrift, hiddenBehind] },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: noiseDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: noiseP4Log,
      UNIVERSE_P4DELTA_SCOPE_LOG: noiseScopeLog,
    },
  })

  test('one folder is hidden from the scan and the batch collect, and a plain get still moves it @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    test.setTimeout(180_000)
    await evaluateWhenRestored(page)

    for (const seed of [inScopeDrift, hiddenDrift, hiddenBehind]) {
      writeFileSync(perforce.file(seed.relPath), DRIFT, 'utf8')
    }
    writeProjectSettings(perforce.clientRoot, {
      'perforce.reconcile.excludeFolders': ['gen'],
    })

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    const groupIdsFor = groupIdsFactory(page)
    const hiddenPath = `directory:${toPosix(perforce.file('gen'))}`

    await test.step('the scan really runs over the range minus the noise', async () => {
      // The range the engine was handed: the workspace root, with the noise as a
      // typed exclusion. The request file is deleted after the run, so this log
      // is the only surviving record — and it is what separates "the hidden
      // folder was pruned before the walk" from "its rows were filtered after".
      //
      // Two waits on purpose: "no round resolved at all" (a cold-start / host
      // problem) and "a round that does not carry the rule" (the setting never
      // reached the engine) must not read as the same failure.
      await expect
        .poll(() => scopeLines(noiseScopeLog).filter((r) => r.mode === 'open').length, {
          timeout: 60_000,
          message: 'the scan should have resolved an open-mode round',
        })
        .toBeGreaterThan(0)
      await expect
        .poll(
          () =>
            scopeLines(noiseScopeLog)
              .filter((r) => r.mode === 'open')
              .flatMap((r) => excludesOf(r)),
          {
            timeout: 60_000,
            message: 'the scan should carry the configured noise as an exclusion',
          },
        )
        .toContain(hiddenPath)
      expect(
        scopeLines(noiseScopeLog)
          .filter((r) => r.mode === 'open')
          .flatMap((r) => entriesOf(r)),
      ).toContain(`directory:${toPosix(perforce.clientRoot)}`)
    })

    await test.step('the hidden drift never becomes a row, and the visible one does', async () => {
      await expect
        .poll(() => groupIdsFor(inScopeDrift.relPath), {
          timeout: 60_000,
          message: 'the in-scope drift should reach the Changes group',
        })
        .toContain('reconcile')
      // On disk, inside the hidden folder: no row, ever.
      expect(await groupIdsFor(hiddenDrift.relPath)).toEqual([])
      // …and its bytes were never touched by the scan.
      expect(readFileSync(perforce.file(hiddenDrift.relPath), 'utf8')).toBe(DRIFT)
    })

    await test.step('a batch collect over the parent leaves the hidden subtree unopened', async () => {
      const before = scopeLines(noiseScopeLog).length
      // The workspace ROOT as an explicit target: it CONTAINS the hidden folder,
      // so a collect that only trusted the scan's answer would still walk into it.
      // No dialog here — a parent holding a hidden subtree is an ordinary batch
      // operation, pruned silently (the confirmation is for targets the user
      // NAMES, below).
      await workbench.runCommand('perforce.reconcile', rootTarget(perforce.clientRoot), [
        rootTarget(perforce.clientRoot),
      ])

      // The world: the visible drift is open for edit…
      await expect
        .poll(() => Object.keys(openedOf(p4Workspace.stateFile)), {
          timeout: 60_000,
          message: 'the collect should open the visible drift',
        })
        .toContain('//depot/src/keep.txt')
      // …the hidden one is NOT (a run that widened past the noise would have
      // opened it — `gen/skip.txt` is drift exactly like the other one)…
      expect(Object.keys(openedOf(p4Workspace.stateFile))).not.toContain('//depot/gen/skip.txt')
      // …and its bytes are still the uncollected draft.
      expect(readFileSync(perforce.file(hiddenDrift.relPath), 'utf8')).toBe(DRIFT)

      // The shape of THAT collect, from the engine's own log: it was asked for the
      // root (the target the user named), and it resolved to a range that is the
      // root minus the noise. Read on the rounds the collect itself produced, so
      // the scan above cannot satisfy it.
      const collectRounds = scopeLines(noiseScopeLog).slice(before)
      expect(collectRounds.flatMap((r) => askedFor(r))).toContain(
        `directory:${toPosix(perforce.clientRoot)}`,
      )
      const writeRounds = collectRounds.filter((r) => r.mode === 'open')
      expect(writeRounds.flatMap((r) => excludesOf(r))).toContain(hiddenPath)
      expect(writeRounds.flatMap((r) => entriesOf(r))).toContain(
        `directory:${toPosix(perforce.clientRoot)}`,
      )
      // …and carrying the rule is not a reason to step aside: the write went to
      // the engine that understands it, the native fallback was handed nothing
      // (its argv log is empty — a fallback there would be logged like any other
      // native call, and could only be a widening).
      expect(readArgvLog(noiseP4Log)).toEqual([])
    })

    await test.step('a plain get ignores the noise and really lands the hidden file on head', async () => {
      const before = scopeLines(noiseScopeLog).filter((r) => r.mode === 'sync').length
      await page.evaluate(() => void window.__E2E__!.runCommand('perforce.syncLatest'))

      // Disk AND the have list: the noise is a reconcile rule, so a get must
      // transfer the file inside the hidden folder like any other.
      await expect
        .poll(() => readFileSync(perforce.file(hiddenBehind.relPath), 'utf8'), {
          timeout: 60_000,
          message: 'a plain get should land the hidden folder file on its head revision',
        })
        .toBe(HEAD)
      await expect
        .poll(() => haveRevOrHead(p4Workspace.stateFile, hiddenBehind), {
          timeout: 30_000,
          message: 'the have list should record the new revision',
        })
        .toBe(2)

      // …and its own logged range says so: the scope, with NOTHING excluded by
      // the setting. A get that inherited the noise would not have moved this
      // file at all.
      const syncRounds = scopeLines(noiseScopeLog)
        .slice(before)
        .filter((r) => r.mode === 'sync')
      expect(syncRounds.length).toBeGreaterThan(0)
      expect(syncRounds.flatMap((r) => entriesOf(r))).toContain(
        `directory:${toPosix(perforce.clientRoot)}`,
      )
      expect(syncRounds.flatMap((r) => excludesOf(r))).not.toContain(hiddenPath)
    })
  })
})

/** A clean over a parent that holds the hidden subtree. */
const cleanLevel: SeedFile = { relPath: 'sub/level.txt', content: HAVE }
const cleanHidden: SeedFile = { relPath: 'sub/hidden/kept.txt', content: HAVE }

const cleanDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const cleanP4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')
const cleanScopeLog = join(mkTempDir('ue2-p4delta-scope-'), 'scope.log')

test.describe('@p1 perforce noise vs a directory clean', () => {
  test.use({
    p4Seeds: { files: [cleanLevel, cleanHidden] },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: cleanDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: cleanP4Log,
      UNIVERSE_P4DELTA_SCOPE_LOG: cleanScopeLog,
    },
  })

  test('a clean over the parent carves around the hidden subtree instead of walking it @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(180_000)
    await evaluateWhenRestored(page)

    for (const seed of [cleanLevel, cleanHidden]) {
      writeFileSync(perforce.file(seed.relPath), DRIFT, 'utf8')
    }
    writeProjectSettings(perforce.clientRoot, {
      'perforce.reconcile.excludeFolders': ['sub/hidden'],
    })

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    // Clean `sub` the way the Explorer context menu does (directory as the
    // primary arg and as the materialized selection); it blocks on its own
    // confirm dialog, so fire-and-forget then answer.
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

    // The clean's range: the selected directory WITH the hidden subtree as an
    // exclusion. `p4 clean -a` DELETES unmanaged files, so a clean that walked
    // the whole `sub` would destroy the draft this setting exists to protect.
    await expect
      .poll(
        () =>
          scopeLines(cleanScopeLog)
            .filter((r) => r.mode === 'clean')
            .flatMap((r) => r.excludes.map(toPosix)),
        { timeout: 60_000, message: 'the clean should carry the hidden folder as an exclusion' },
      )
      .toContain(`directory:${toPosix(perforce.file('sub/hidden'))}`)

    // The world: the level's own drift is gone…
    await expect
      .poll(() => readFileSync(perforce.file(cleanLevel.relPath), 'utf8'), {
        timeout: 30_000,
        message: 'the clean should restore the level file to its have revision',
      })
      .toBe(HAVE)
    // …and the hidden subtree's draft is exactly where it was.
    expect(readFileSync(perforce.file(cleanHidden.relPath), 'utf8')).toBe(DRIFT)
  })
})

/** A file NAMED directly inside the hidden folder — the one shape that gets a
 *  dialog, and the two answers are asserted separately below. */
const namedHidden: SeedFile = { relPath: 'gen/named.txt', content: HAVE }
const siblingHidden: SeedFile = { relPath: 'gen/other.txt', content: HAVE }

const namedDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const namedP4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')
const namedScopeLog = join(mkTempDir('ue2-p4delta-scope-'), 'scope.log')

test.describe('@p1 perforce noise vs a directly named target', () => {
  test.use({
    p4Seeds: { files: [namedHidden, siblingHidden] },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: namedDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: namedP4Log,
      UNIVERSE_P4DELTA_SCOPE_LOG: namedScopeLog,
    },
  })

  test('a target the user names inside the hidden folder is asked about, and each answer has its own consequence @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    test.setTimeout(180_000)
    await evaluateWhenRestored(page)

    for (const seed of [namedHidden, siblingHidden]) {
      writeFileSync(perforce.file(seed.relPath), DRIFT, 'utf8')
    }
    writeProjectSettings(perforce.clientRoot, {
      'perforce.reconcile.excludeFolders': ['gen'],
    })

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    const collectNamed = (relPath: string): void => {
      void page
        .evaluate(
          (args) =>
            void window.__E2E__!.runCommand('perforce.reconcile', { resourceUri: args.uri }),
          { uri: perforce.file(relPath) },
        )
        .catch(() => {})
    }

    await test.step('"Skip them" writes nothing at all', async () => {
      const deltaBefore = readArgvLog(namedDeltaLog).length
      collectNamed(namedHidden.relPath)

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      // The path is named, and it is the SETTING being reported — not the scope.
      await expect(dialog).toContainText('reconcile exclusions')
      await expect(dialog).toContainText('named.txt')
      await dialog.getByRole('button', { name: 'Skip them' }).click()

      // The user is told the operation did not run (an empty target list is not a
      // smaller operation)…
      await expect(
        page
          .locator('[data-testid="notification-toast-item"]')
          .filter({ hasText: 'hidden by the exclusions in force' }),
      ).toBeVisible({ timeout: 30_000 })
      // …nothing was spawned…
      expect(readArgvLog(namedDeltaLog).length).toBe(deltaBefore)
      // …and the draft is untouched, still uncollected.
      expect(Object.keys(openedOf(p4Workspace.stateFile))).not.toContain('//depot/gen/named.txt')
      expect(readFileSync(perforce.file(namedHidden.relPath), 'utf8')).toBe(DRIFT)
    })

    await test.step('"Run as chosen" collects exactly the named file', async () => {
      collectNamed(namedHidden.relPath)

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await dialog.getByRole('button', { name: 'Run as chosen' }).click()

      // The lift is per TARGET: the named file is collected…
      await expect
        .poll(() => Object.keys(openedOf(p4Workspace.stateFile)), {
          timeout: 60_000,
          message: 'the confirmed collect should open the named file',
        })
        .toContain('//depot/gen/named.txt')

      // …and the round ran over exactly it — a FILE target, not the hidden
      // directory: lifting the rule for the whole folder would collect the
      // sibling draft the user never named. The round's TARGETS say what it was
      // asked for, its INCLUDES what the config left of that.
      const namedRounds = scopeLines(namedScopeLog)
      expect(namedRounds.flatMap((r) => askedFor(r))).toContain(
        `file:${toPosix(perforce.file(namedHidden.relPath))}`,
      )
      const ranRounds = namedRounds.filter((r) => r.mode === 'open')
      expect(ranRounds.flatMap((r) => entriesOf(r))).toContain(
        `file:${toPosix(perforce.file(namedHidden.relPath))}`,
      )
      expect(ranRounds.flatMap((r) => entriesOf(r))).not.toContain(
        `directory:${toPosix(perforce.file('gen'))}`,
      )
      expect(Object.keys(openedOf(p4Workspace.stateFile))).not.toContain('//depot/gen/other.txt')
      expect(readFileSync(perforce.file(siblingHidden.relPath), 'utf8')).toBe(DRIFT)
    })
  })
})

/** The three layers at once: the scope file decides the range, the focus narrows
 *  the scan, the noise hides one of the scope's own directories. */
const layerScopeIn: SeedFile = { relPath: 'src/keep.txt', content: HAVE }
const layerFocus: SeedFile = { relPath: 'sub/deep.txt', content: HAVE }
const layerNoise: SeedFile = { relPath: 'gen/out.txt', content: HAVE }

const layeringDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const layeringP4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')
const layeringScopeLog = join(mkTempDir('ue2-p4delta-scope-'), 'scope.log')

test.describe('@p1 perforce scope, focus and noise stay separate layers', () => {
  test.use({
    p4Seeds: { files: [layerScopeIn, layerFocus, layerNoise] },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: layeringDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: layeringP4Log,
      UNIVERSE_P4DELTA_SCOPE_LOG: layeringScopeLog,
    },
  })

  test('the scan resolves scope ∩ focus − noise, and the get that follows resolves the scope alone @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(180_000)
    await evaluateWhenRestored(page)

    for (const seed of [layerScopeIn, layerFocus, layerNoise]) {
      writeFileSync(perforce.file(seed.relPath), DRIFT, 'utf8')
    }
    // The config only EXCLUDES, so its own directory is the include; the focus
    // and the noise then narrow THAT. The settings file must exist before the
    // workspace opens for its watcher, and the focus is applied from the start
    // here (the round under test is the first one).
    writeScopeFile(perforce.clientRoot, undefined, ['src'])
    writeProjectSettings(perforce.clientRoot, {
      'workspace.focusEnabled': true,
      'workspace.focusFolders': { sub: true },
      'perforce.reconcile.excludeFolders': ['gen'],
    })

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    await test.step('the scan is the intersection, minus the noise', async () => {
      // The focused directory is the round's target, and the noise rides along
      // as its own exclusion: three rules, one resolved range.
      await expect
        .poll(
          () =>
            scopeLines(layeringScopeLog)
              .filter((r) => r.mode === 'open')
              .flatMap((r) => entriesOf(r)),
          { timeout: 60_000, message: 'the scan should resolve to the focused intersection' },
        )
        .toContain(`directory:${toPosix(perforce.file('sub'))}`)
      const scanRounds = scopeLines(layeringScopeLog).filter((r) => r.mode === 'open')
      const excludes = scanRounds.flatMap((r) => excludesOf(r))
      expect(excludes).toContain(`directory:${toPosix(perforce.file('gen'))}`)
      // The scope's own exclusion is re-read from the config (never repeated by
      // the editor), and the whole scope is NOT the scan's range.
      expect(excludes).toContain(`directory:${toPosix(perforce.file('src'))}`)
      expect(scanRounds.flatMap((r) => entriesOf(r))).not.toContain(
        `directory:${toPosix(perforce.clientRoot)}`,
      )
    })

    await test.step('the plain get resolves the scope, with neither focus nor noise', async () => {
      const before = scopeLines(layeringScopeLog).filter((r) => r.mode === 'sync').length
      await page.evaluate(() => void window.__E2E__!.runCommand('perforce.syncLatest'))

      await expect
        .poll(() => scopeLines(layeringScopeLog).filter((r) => r.mode === 'sync').length, {
          timeout: 60_000,
          message: 'the get should have resolved its own range',
        })
        .toBeGreaterThan(before)

      const syncRounds = scopeLines(layeringScopeLog)
        .slice(before)
        .filter((r) => r.mode === 'sync')
      const includes = syncRounds.flatMap((r) => entriesOf(r))
      const excludes = syncRounds.flatMap((r) => excludesOf(r))
      // The scope's whole range…
      expect(includes).toContain(`directory:${toPosix(perforce.clientRoot)}`)
      // …minus the SCOPE's own exclusion only: the focus does not narrow a get,
      // and the noise does not follow one.
      expect(includes).not.toContain(`directory:${toPosix(perforce.file('sub'))}`)
      expect(excludes).toContain(`directory:${toPosix(perforce.file('src'))}`)
      expect(excludes).not.toContain(`directory:${toPosix(perforce.file('gen'))}`)
    })
  })
})

/** The setting is read BEFORE the folder it names exists: `sub/hidden` is created
 *  only after activation, so the rule was resolved while there was nothing to
 *  stat — the order that used to freeze it as a FILE (hiding the name alone, so
 *  the day the folder appears the scan reports its drift, a collect opens it and
 *  `p4 clean -a` DELETES inside it). The clean runs over `sub` rather than the
 *  workspace root, which keeps the destructive half away from the project
 *  settings file the run itself depends on. */
const lateLevel: SeedFile = { relPath: 'sub/level.txt', content: HAVE }
/** Written to disk after the workspace is up: drift inside the folder that
 *  appeared later, and a visible sibling created in the same breath — the
 *  liveness anchor for the negative assertions. */
const lateVisible = { relPath: 'sub/late.txt', content: DRIFT }
const lateHidden = { relPath: 'sub/hidden/kept.txt', content: DRIFT }
/** Also inside the folder that appeared later, but tracked: only the plain get
 *  below moves it. Its depot entry is added to the fake's state when the file
 *  appears (a seed would have created the folder before activation). */
const lateBehind = { relPath: 'sub/hidden/behind.txt', content: HAVE }

const lateDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const lateP4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')
const lateScopeLog = join(mkTempDir('ue2-p4delta-scope-'), 'scope.log')

/** Add a tracked file to the fake's world AFTER the workspace is up: head ahead
 *  of have, with the have content on disk — so a plain get has something real to
 *  transfer inside a folder no seed could have produced. */
function seedLateDepotFile(stateFile: string, relPath: string, have: string, head: string): void {
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
    files?: Record<string, unknown>
  }
  state.files = state.files ?? {}
  state.files[`//depot/${toPosix(relPath)}`] = {
    rev: 2,
    content: head,
    haveRev: 1,
    haveContent: have,
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
}

test.describe('@p1 perforce noise configured before the hidden folder exists', () => {
  test.use({
    p4Seeds: { files: [lateLevel] },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: lateDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: lateP4Log,
      UNIVERSE_P4DELTA_SCOPE_LOG: lateScopeLog,
    },
  })

  test('a folder hidden before it existed stays hidden once it appears, and a plain get still moves it @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    test.setTimeout(240_000)
    await evaluateWhenRestored(page)

    writeFileSync(perforce.file(lateLevel.relPath), DRIFT, 'utf8')
    // Read at activation, while the folder it names does not exist yet.
    writeProjectSettings(perforce.clientRoot, {
      'perforce.reconcile.excludeFolders': ['sub/hidden'],
    })
    expect(existsSync(perforce.file('sub/hidden'))).toBe(false)

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    const groupIdsFor = groupIdsFactory(page)
    const hiddenDir = `directory:${toPosix(perforce.file('sub/hidden'))}`
    const hiddenFile = `file:${toPosix(perforce.file(lateHidden.relPath))}`

    await test.step('a folder nobody can stat yet is still resolved as a FOLDER rule', async () => {
      // Two waits on purpose, as in the first journey: "no round resolved at all"
      // (the scan never reached δ — a cold start or a host problem) and "a round
      // that does not carry the rule" (the setting never reached the client) must
      // not read as the same failure. A round appears in this log only once δ runs:
      // the narrow queries follow the SCAN's engine verdict, which starts as
      // native, so a round-less log means the scan never got to the engine.
      await expect
        .poll(() => scopeLines(lateScopeLog).filter((r) => r.mode === 'open').length, {
          timeout: 60_000,
          message: 'the scan should have resolved an open-mode round',
        })
        .toBeGreaterThan(0)
      // The KIND is what δ is told, and it is the whole regression: a `file`
      // entry hides the name `sub/hidden` and nothing under it, so the rule
      // quietly stops covering the tree the moment the tree exists.
      await expect
        .poll(
          () =>
            scopeLines(lateScopeLog)
              .filter((r) => r.mode === 'open')
              .flatMap((r) => excludesOf(r)),
          { timeout: 60_000, message: 'the scan should carry the folder as a directory rule' },
        )
        .toContain(hiddenDir)
    })

    // The folder appears AFTER activation, with drift inside it, a tracked file
    // next to it, and a visible sibling as the liveness anchor.
    mkdirSync(perforce.file('sub/hidden'), { recursive: true })
    writeFileSync(perforce.file(lateHidden.relPath), lateHidden.content, 'utf8')
    writeFileSync(perforce.file(lateBehind.relPath), lateBehind.content, 'utf8')
    writeFileSync(perforce.file(lateVisible.relPath), lateVisible.content, 'utf8')
    seedLateDepotFile(p4Workspace.stateFile, lateBehind.relPath, HAVE, HEAD)

    await test.step('the scan never even asks about the folder that appeared later', async () => {
      // Liveness FIRST: the watcher's round for the visible sibling has to land,
      // or the negative below would only prove nothing had happened yet. The three
      // files appeared in one burst right after activation, and the round the
      // refresh tail armed can already have been in flight then — one that started
      // before the batch answers nothing about it. So the poll re-touches the
      // sibling (same bytes, idempotent) to re-arm a round; bounded, because past
      // a few nudges the remaining polls should observe rather than keep writing.
      // The hidden subtree is NEVER touched: it is what the negatives below assert
      // about, and a nudge there would arrange the very answer they check.
      let rearms = 0
      await expect
        .poll(
          async () => {
            const groups = await groupIdsFor(lateVisible.relPath)
            if (!groups.includes('reconcile') && rearms < 5) {
              rearms++
              writeFileSync(perforce.file(lateVisible.relPath), lateVisible.content, 'utf8')
            }
            return groups
          },
          {
            timeout: 60_000,
            intervals: [500, 1000],
            message: 'the late sibling should reach the Changes group',
          },
        )
        .toContain('reconcile')
      // The hidden pair was created in the same batch: no row, and no round ever
      // named the file inside the folder as a target (the engine that answered
      // the visible sibling would have reported both).
      expect(await groupIdsFor(lateHidden.relPath)).toEqual([])
      expect(scopeLines(lateScopeLog).flatMap((r) => askedFor(r))).not.toContain(hiddenFile)
      expect(readFileSync(perforce.file(lateHidden.relPath), 'utf8')).toBe(DRIFT)
    })

    await test.step('a batch collect over the parent leaves the folder that appeared later alone', async () => {
      const before = scopeLines(lateScopeLog).length
      await workbench.runCommand('perforce.reconcile', rootTarget(perforce.clientRoot), [
        rootTarget(perforce.clientRoot),
      ])
      const opened = (): string[] => Object.keys(openedOf(p4Workspace.stateFile))
      await expect
        .poll(opened, {
          timeout: 60_000,
          message: 'the collect should open the visible late drift',
        })
        .toContain('//depot/sub/late.txt')
      expect(opened()).not.toContain('//depot/sub/hidden/kept.txt')
      expect(readFileSync(perforce.file(lateHidden.relPath), 'utf8')).toBe(DRIFT)

      // …and the write's OWN range says the same: the folder rides along as a
      // directory exclusion on the round the collect itself produced. The window
      // is narrowed to the rounds ASKED ABOUT the workspace root: the per-file
      // narrow queries (the sibling's rewrites re-arm them) carry the same
      // exclusions, so an unfiltered window could pass without the collect having
      // carried anything at all.
      const rootAsked = `directory:${toPosix(perforce.clientRoot)}`
      const writeRounds = scopeLines(lateScopeLog)
        .slice(before)
        .filter((r) => r.mode === 'open' && askedFor(r).includes(rootAsked))
      expect(writeRounds.length).toBeGreaterThan(0)
      expect(writeRounds.flatMap((r) => excludesOf(r))).toContain(hiddenDir)
      expect(readArgvLog(lateP4Log)).toEqual([])
    })

    await test.step('a clean over the parent does not delete inside it', async () => {
      // `p4 clean -a` DELETES unmanaged files, so this is the sharpest half:
      // `sub/hidden/kept.txt` is unmanaged drift exactly like `sub/late.txt`.
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
      // The collect above left both visible files OPEN, so this is the opened
      // flavor of the confirm — the clean half rides along for the directory.
      await expect(dialog).toContainText('Local changes will be lost.')
      await dialog.getByRole('button', { name: 'Revert' }).click()

      // The clean really ran over `sub`, and its own range says what it walked:
      // the folder that appeared later rides along as a DIRECTORY exclusion.
      await expect
        .poll(
          () =>
            scopeLines(lateScopeLog)
              .filter((r) => r.mode === 'clean')
              .flatMap((r) => excludesOf(r)),
          { timeout: 60_000, message: 'the clean should carry the late folder as an exclusion' },
        )
        .toContain(hiddenDir)

      // The level file — collected above, so reopened cold here — really came
      // back to its have revision…
      await expect
        .poll(() => readFileSync(perforce.file(lateLevel.relPath), 'utf8'), {
          timeout: 30_000,
          message: 'the revert should restore the level file',
        })
        .toBe(HAVE)
      // …and the draft inside the folder that appeared later is exactly where it
      // was: a run that walked it would have deleted it.
      expect(readFileSync(perforce.file(lateHidden.relPath), 'utf8')).toBe(DRIFT)
    })

    await test.step('a plain get still moves the folder that appeared later', async () => {
      const before = scopeLines(lateScopeLog).filter((r) => r.mode === 'sync').length
      await page.evaluate(() => void window.__E2E__!.runCommand('perforce.syncLatest'))

      // Disk AND the have list: the noise is a reconcile rule, so a get carries
      // the file like any other — including in a folder that did not exist when
      // the setting was read.
      await expect
        .poll(() => readFileSync(perforce.file(lateBehind.relPath), 'utf8'), {
          timeout: 60_000,
          message: 'a plain get should land the late folder file on its head revision',
        })
        .toBe(HEAD)
      await expect
        .poll(
          () => haveRevOrHead(p4Workspace.stateFile, { relPath: lateBehind.relPath, headRev: 2 }),
          {
            timeout: 30_000,
            message: 'the have list should record the new revision',
          },
        )
        .toBe(2)

      const syncRounds = scopeLines(lateScopeLog)
        .slice(before)
        .filter((r) => r.mode === 'sync')
      expect(syncRounds.flatMap((r) => entriesOf(r))).toContain(
        `directory:${toPosix(perforce.clientRoot)}`,
      )
      expect(syncRounds.flatMap((r) => excludesOf(r))).not.toContain(hiddenDir)
    })
  })
})

/** The native fallback under a summary-less engine, with the noise in force. */
const nativeLevel: SeedFile = { relPath: 'src/level.txt', content: HAVE }
const nativeHidden: SeedFile = { relPath: 'gen/skip.txt', content: HAVE }

const fallbackDeltaLog = join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log')
const fallbackP4Log = join(mkTempDir('ue2-p4-argv-'), 'p4.log')

test.describe('@p1 perforce noise vs the native fallback', () => {
  test.use({
    p4Seeds: { files: [nativeLevel, nativeHidden] },
    p4delta: { fail: 'nosummary' },
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: fallbackDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: fallbackP4Log,
    },
  })

  test('a fallback round keeps the noise, and never widens to the whole workspace @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    test.setTimeout(180_000)
    await evaluateWhenRestored(page)

    for (const seed of [nativeLevel, nativeHidden]) {
      writeFileSync(perforce.file(seed.relPath), DRIFT, 'utf8')
    }
    writeProjectSettings(perforce.clientRoot, {
      'perforce.reconcile.excludeFolders': ['gen'],
    })

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    const groupIdsFor = groupIdsFactory(page)
    const rootPosix = toPosix(perforce.clientRoot)
    const nativeScanLines = (): string[] =>
      readArgvLog(fallbackP4Log).filter((l) => l.includes('reconcile') && /(^| )-n( |$)/.test(l))

    await test.step('the scan falls back natively and still reaches the visible drift', async () => {
      await expect
        .poll(() => nativeScanLines().length, {
          timeout: 60_000,
          message: 'the summary-less δ round should have re-run the scan natively',
        })
        .toBeGreaterThan(0)
      await expect
        .poll(() => groupIdsFor(nativeLevel.relPath), {
          timeout: 60_000,
          message: 'the fallback round should still publish the visible drift',
        })
        .toContain('reconcile')
      // The hidden folder's drift is on disk exactly like the other one.
      expect(await groupIdsFor(nativeHidden.relPath)).toEqual([])
    })

    await test.step('the native round carves around the noise, never over it', async () => {
      // The carve's shape: the level's `<root>/*` plus the clean subtrees. What
      // must NOT appear is the recursive whole-workspace spec — that one drags
      // the hidden subtree back into p4's traversal — nor the hidden folder's
      // own path in any spelling.
      const scans = nativeScanLines().map(toPosix)
      expect(scans.some((l) => l.includes(`${rootPosix}/*`))).toBe(true)
      expect(scans.filter((l) => l.includes(`${rootPosix}/...`))).toEqual([])
      expect(scans.filter((l) => l.includes(`${rootPosix}/gen`))).toEqual([])
    })

    await test.step('the collect is native too (δ never proved itself) and still prunes the noise', async () => {
      // The write path asks the scan's engine verdict itself (`_p4deltaEngine()`,
      // inside `_mutateWrite`), and under this fault no round ever proved δ — so
      // this collect takes the native carve, built at this instant.
      await workbench.runCommand('perforce.reconcile', rootTarget(perforce.clientRoot), [
        rootTarget(perforce.clientRoot),
      ])

      await expect
        .poll(() => Object.keys(openedOf(p4Workspace.stateFile)), {
          timeout: 60_000,
          message: 'the native collect should open the visible drift',
        })
        .toContain('//depot/src/level.txt')
      expect(Object.keys(openedOf(p4Workspace.stateFile))).not.toContain('//depot/gen/skip.txt')

      // The native collect's own argv: the same carved shape, and no `-a` over
      // the whole workspace. (The dry runs above share the log; an APPLY line is
      // the one here.)
      const applies = readArgvLog(fallbackP4Log)
        .filter((l) => l.includes('reconcile') && !/(^| )-n( |$)/.test(l))
        .map(toPosix)
      expect(applies.length).toBeGreaterThan(0)
      expect(applies.filter((l) => l.includes(`${rootPosix}/...`))).toEqual([])
      expect(applies.filter((l) => l.includes(`${rootPosix}/gen`))).toEqual([])
      expect(readFileSync(perforce.file(nativeHidden.relPath), 'utf8')).toBe(DRIFT)
    })
  })
})
