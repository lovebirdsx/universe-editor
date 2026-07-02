/*---------------------------------------------------------------------------------------------
 *  Markdown "move updates links — no stale diagnostic" smoke (P1).
 *
 *  Regression for the bug where, after a linked file B is moved while the
 *  referencing file A is closed, A's link is rewritten on disk but the markdown
 *  language service kept validating B's OLD path (we have no filesystem watcher),
 *  so reopening A warned "file does not exist" at the pre-move path.
 *
 *  Path exercised: open A once (primes the per-document link cache) → close A →
 *  move B into a subfolder through the explorer (fires onDidRunFileOperation, the
 *  contribution rewrites A on disk AND notifies the service via didChangeFiles) →
 *  reopen A → assert no broken-link marker remains.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

function writeWorkspace(): { dir: string; aPath: string; bPath: string; subDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-mdmove-'))
  const subDir = join(dir, 'sub')
  mkdirSync(subDir)
  const aPath = join(dir, 'a.md')
  const bPath = join(dir, 'b.md')
  writeFileSync(aPath, '# Alpha\n\nSee [the doc](./b.md).\n')
  writeFileSync(bPath, '# Beta\n')
  return {
    dir: dir.replace(/\\/g, '/'),
    aPath: aPath.replace(/\\/g, '/'),
    bPath: bPath.replace(/\\/g, '/'),
    subDir: subDir.replace(/\\/g, '/'),
  }
}

test.describe('@p1 markdown move: no stale broken-link diagnostic', () => {
  test('reopening the referrer after moving its target shows no missing-file warning', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, aPath, bPath, subDir } = writeWorkspace()
    const aUri = `file:///${aPath}`
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('markdown.updateLinksOnFileMove.enabled', 'always'),
    )

    // 1) Open A so the language service caches its (old) link, then close it.
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath, { pinned: true }), aPath)
    await expect
      .poll(() => page.evaluate((uri) => window.__E2E__!.getMarkdownMarkers(uri).length, aUri), {
        timeout: 15000,
      })
      .toBe(0)
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.closeAllEditors'))

    // 2) Move B into sub/ through the explorer (rewrites A on disk + notifies).
    await page.evaluate(
      ([fsPath, destDir]) => window.__E2E__!.moveExplorerResource(fsPath, destDir),
      [bPath, subDir] as const,
    )

    // The on-disk link is rewritten to ./sub/b.md.
    await expect
      .poll(() => page.evaluate((fsPath) => window.__E2E__!.readWorkspaceFileText(fsPath), aPath), {
        timeout: 15000,
      })
      .toContain('./sub/b.md')

    // 3) Reopen A: no broken-link marker for the pre-move path may remain.
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath, { pinned: true }), aPath)
    await expect
      .poll(() => page.evaluate((uri) => window.__E2E__!.getMarkdownMarkers(uri), aUri), {
        timeout: 15000,
      })
      .toEqual([])
  })
})
