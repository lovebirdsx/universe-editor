/*---------------------------------------------------------------------------------------------
 *  Markdown "update links on file rename" smoke (P1).
 *
 *  Renames a markdown file that another file links to, and asserts the link in
 *  the other file is rewritten to the new path. Drives the real ExplorerTreeService
 *  rename (the F2 path) + the markdown plugin's getRenameFileEdits + the bulk-edit
 *  apply, end to end. The setting is forced to `always` so no modal blocks the run.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/markdownApp.js'

function writeWorkspace(): { dir: string; aPath: string; bPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-mdrename-'))
  const aPath = join(dir, 'a.md')
  const bPath = join(dir, 'b.md')
  // a.md links to b.md; renaming b.md → c.md must rewrite this link.
  writeFileSync(aPath, '# Alpha\n\nSee [the doc](./b.md).\n')
  writeFileSync(bPath, '# Beta\n')
  return {
    dir: dir.replace(/\\/g, '/'),
    aPath: aPath.replace(/\\/g, '/'),
    bPath: bPath.replace(/\\/g, '/'),
  }
}

test.describe('@p1 markdown update links on rename', () => {
  test('rewrites a link in another file when its target is renamed', async ({
    page,
    workbench,
  }) => {
    // Spawns a real LSP subprocess; cold start is slow on contended CI runners.
    test.slow()
    await workbench.waitForRestored()

    const { dir, aPath, bPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)

    // Force auto-apply so the confirm modal doesn't block a headless run.
    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('markdown.updateLinksOnFileMove.enabled', 'always'),
    )

    // a.md is left UNOPENED so the edit is written to disk (the bulk-edit disk
    // path). The contribution activates the markdown plugin itself on rename.
    // Rename b.md → c.md through the explorer (fires onDidRunFileOperation).
    await page.evaluate((fsPath) => window.__E2E__!.renameExplorerResource(fsPath, 'c.md'), bPath)

    // The link in a.md is rewritten to ./c.md (poll: activation + debounce + apply).
    await expect
      .poll(() => page.evaluate((fsPath) => window.__E2E__!.readWorkspaceFileText(fsPath), aPath), {
        timeout: 15000,
      })
      .toContain('./c.md')
  })
})
