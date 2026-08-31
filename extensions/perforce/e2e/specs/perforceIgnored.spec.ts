/*---------------------------------------------------------------------------------------------
 *  Perforce ignored-file dimming smoke (@p1).
 *
 *  The Explorer row / editor tab dimming reads one cached boolean from
 *  `ScmIgnoredResourcesService.isIgnored`, which batch-resolves unknown paths
 *  through the owning provider's `<providerId>.checkIgnore` command. This spec
 *  drives that whole chain against the fake p4 — renderer cache → host command
 *  routing by owning client → `p4 ignores -i` → the depot filter — because every
 *  link is invisible from a unit test:
 *
 *  1. A local-only file a rule excludes answers `true` (the feature itself).
 *  2. A local-only file NO rule excludes answers `false` in the same run — a
 *     blanket `true` would dim the entire tree and still pass assertion 1.
 *  3. A file that a rule matches but that IS in the depot answers `false`. This
 *     is the depot filter: `p4 ignores -i` is a pure rule evaluator (unlike
 *     git's `check-ignore`, which consults the index), so without the filter
 *     whole regions of controlled content would go grey.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { SeedFile } from '../fixtures/perforceApp.js'

// Local-only files: the only kind ignore rules are meant to hide. `untracked`
// keeps them out of the depot so the depot filter is a no-op for them.
const ignoredFile: SeedFile = {
  relPath: 'build/output.log',
  content: 'build noise\n',
  untracked: true,
}
const keptFile: SeedFile = { relPath: 'keep.txt', content: 'keep me bright\n', untracked: true }
// Matched by a rule AND present in the depot — the depot filter must win.
const depotMatchedFile: SeedFile = { relPath: 'generated.txt', content: 'controlled\n' }

// Client-root-relative rules the fake p4 evaluates for `ignores -i`: a directory
// prefix and an exact path.
const IGNORE_RULES = ['build', 'generated.txt'] as const

/** `perforce.file()` hands back a forward-slashed absolute path (`C:/…` or `/tmp/…`). */
const fileUri = (abs: string): string => `file:///${abs.replace(/^\/+/, '')}`

test.describe('@p1 perforce ignored files', () => {
  test.use({
    p4Seeds: {
      files: [ignoredFile, keptFile, depotMatchedFile],
      ignored: IGNORE_RULES,
    },
  })

  test('p4-ignored files dim, tracked and unmatched files stay bright @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)
    await workbench.openWorkspace(perforce.openDir)

    // The ignore lookup routes through the owning provider's checkIgnore command,
    // so the perforce SourceControl has to be registered first.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceCommands(workbench)

    // isIgnored is a pull-style cache: the first read enqueues and answers
    // undefined, so poll until the batch resolves.
    const isIgnored = (relPath: string): Promise<boolean | undefined> =>
      page.evaluate((uri) => window.__E2E__!.isResourceGitIgnored(uri), fileUri(perforce.file(relPath)))

    await expect
      .poll(() => isIgnored(ignoredFile.relPath), {
        timeout: 30_000,
        message: 'a local-only file under an ignored directory should be dimmed',
      })
      .toBe(true)

    await expect
      .poll(() => isIgnored(keptFile.relPath), {
        timeout: 30_000,
        message: 'a local-only file no rule matches must stay bright',
      })
      .toBe(false)

    await expect
      .poll(() => isIgnored(depotMatchedFile.relPath), {
        timeout: 30_000,
        message: 'a depot-controlled file must stay bright even when a rule matches it',
      })
      .toBe(false)
  })
})
