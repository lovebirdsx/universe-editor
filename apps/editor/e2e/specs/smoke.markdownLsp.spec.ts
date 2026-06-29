/*---------------------------------------------------------------------------------------------
 *  Markdown language server smoke (P1).
 *
 *  Drives the out-of-process markdown LSP through the read-only probe:
 *    1. document symbols (Outline / Breadcrumbs backing)
 *    2. workspace symbols across files (Ctrl+T backing)
 *    3. cross-file definition (F12)
 *    4. broken-link diagnostics (Monaco markers)
 *    5. folding ranges (header sections)
 *    6. document links (Ctrl+Click navigation)
 *    7. hover (link destination preview)
 *    8. path completion (`](` → workspace files)
 *    9. paste-to-link enhancement (uri-list → image link; URL over selection)
 *
 *  Spawns a real subprocess, so each assertion polls — the server starts lazily
 *  on first markdown open and diagnostics arrive after a debounce.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

function writeWorkspace(): { dir: string; aPath: string; cPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-mdls-'))
  const aPath = join(dir, 'a.md')
  writeFileSync(
    aPath,
    '# Alpha\n\n## Beta\n\n[cross](other.md#gamma)\n\n![pic](pic.png)\n\n[broken](#missing)\n',
  )
  writeFileSync(join(dir, 'other.md'), '# Gamma\n\nbody\n')
  writeFileSync(join(dir, 'pic.png'), '')
  // A dangling `](` so a path completion request has somewhere to fire.
  const cPath = join(dir, 'c.md')
  writeFileSync(cPath, '[x](\n')
  return {
    dir: dir.replace(/\\/g, '/'),
    aPath: aPath.replace(/\\/g, '/'),
    cPath: cPath.replace(/\\/g, '/'),
  }
}

test.describe('@p1 markdown language server', () => {
  test('provides symbols, workspace search, cross-file definition, and diagnostics', async ({
    page,
    workbench,
  }) => {
    // Spawns a real LSP subprocess; cold start is slow on contended CI runners.
    test.slow()
    await workbench.waitForRestored()

    const { dir, aPath, cPath } = writeWorkspace()
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

    // 6. Document links — the `[cross](other.md#gamma)` link resolves to other.md.
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getMarkdownDocumentLinks(u), mdUri), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining([expect.stringContaining('other.md')]))

    // 7. Hover — over the image link target on line 7 previews the media path.
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getMarkdownHover(u, 7, 10), mdUri), {
        timeout: 10000,
      })
      .toContain('pic.png')

    // 8. Path completion — `[x](` in c.md offers sibling files (a.md / other.md).
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), cPath)
    const cUri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getMarkdownCompletions(u, 1, 5), cUri), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining([expect.stringContaining('other.md')]))

    // 8b. Anchor completion across the debounce race: replace the buffer with an
    // anchor link into another file, then request completion in the SAME tick (no
    // await between, so the 200ms document-sync debounce has NOT fired). The
    // completion proxy must flush the just-typed text to the host before asking,
    // or the language service parses a stale line and returns no headers.
    // `./other.md#` cursor sits right after `#` (line 1, col 16).
    const anchorLabels = await page.evaluate((u) => {
      window.__E2E__!.setActiveEditorText('[y](./other.md#')
      return window.__E2E__!.getMarkdownCompletions(u, 1, 16)
    }, cUri)
    expect(anchorLabels).toEqual(expect.arrayContaining([expect.stringContaining('gamma')]))

    // 9a. Paste a file uri-list → a workspace-relative markdown image link.
    const picUri = `${dir}/pic.png`
    const imgPaste = await page.evaluate(
      ([u, uriList]) =>
        window.__E2E__!.getMarkdownPasteEdit(u, 'text/uri-list', `file:///${uriList}`),
      [cUri, picUri] as const,
    )
    expect(imgPaste).toBe('![](pic.png)')

    // 9b. Paste a URL over a selection → `[selected](url)`. The buffer is now
    // `[y](./other.md#` (from 8b); select the `y` at line 1, cols 2-3.
    const urlPaste = await page.evaluate(
      (u) =>
        window.__E2E__!.getMarkdownPasteEdit(u, 'text/plain', 'https://example.com', {
          startLineNumber: 1,
          startColumn: 2,
          endLineNumber: 1,
          endColumn: 3,
        }),
      cUri,
    )
    expect(urlPaste).toBe('[y](https://example.com)')
  })
})
