/*---------------------------------------------------------------------------------------------
 *  Markdown language server smoke (P1).
 *
 *  Drives the out-of-process markdown LSP through the read-only probe:
 *    1. document symbols (Outline / Breadcrumbs backing)
 *    2. workspace symbols across files (Ctrl+T backing)
 *    3. cross-file definition (F12)
 *    4. broken-link diagnostics (Monaco markers)
 *    5. folding ranges (header sections)
 *
 *  Spawns a real subprocess, so each assertion polls — the server starts lazily
 *  on first markdown open and diagnostics arrive after a debounce.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

function writeWorkspace(): { dir: string; aPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-mdls-'))
  const aPath = join(dir, 'a.md')
  writeFileSync(aPath, '# Alpha\n\n## Beta\n\n[cross](other.md#gamma)\n\n[broken](#missing)\n')
  writeFileSync(join(dir, 'other.md'), '# Gamma\n\nbody\n')
  return { dir: dir.replace(/\\/g, '/'), aPath: aPath.replace(/\\/g, '/') }
}

test.describe('@p1 markdown language server', () => {
  test('provides symbols, workspace search, cross-file definition, and diagnostics', async ({
    page,
    workbench,
  }) => {
    // Spawns a real LSP subprocess; cold start is slow on contended CI runners.
    test.slow()
    await workbench.waitForRestored()

    const { dir, aPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), aPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    const uri = await page.evaluate(() => window.__E2E__!.getActiveEditorUri())
    expect(uri).toBeTruthy()
    const mdUri = uri as string

    // 1. Document symbols — names carry the heading markup (VSCode parity).
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getMarkdownDocumentSymbols(u), mdUri), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining(['# Alpha', '## Beta']))

    // 2. Workspace symbols — finds the heading in the other (unopened) file.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.queryMarkdownWorkspaceSymbols('Gamma')), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining(['# Gamma']))

    // 3. Cross-file definition — cursor inside `other.md#gamma` on line 5.
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getMarkdownDefinition(u, 5, 12), mdUri), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining([expect.stringContaining('other.md')]))

    // 4. Diagnostics — the `#missing` fragment link is flagged as a warning.
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getMarkdownMarkers(u), mdUri), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining([expect.objectContaining({ severity: 4 })]))

    // 5. Folding ranges — the `# Alpha` section folds from its heading (line 1).
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getMarkdownFoldingRanges(u), mdUri), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining([expect.arrayContaining([1])]))
  })
})
