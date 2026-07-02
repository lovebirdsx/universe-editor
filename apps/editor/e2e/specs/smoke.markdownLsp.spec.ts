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
 *   10. drop-to-link enhancement (uri-list → image link; binary image → assets/)
 *
 *  Spawns a real subprocess, so each assertion polls — the server starts lazily
 *  on first markdown open and diagnostics arrive after a debounce.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
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
    expect(imgPaste).toBe('![${1:alt text}](pic.png)')

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

    // 10a. Drop a file uri-list → the same workspace-relative image link (the
    // drag counterpart of 9a, through the documentDropEditProvider).
    const imgDrop = await page.evaluate(
      ([u, uriList]) =>
        window.__E2E__!.getMarkdownDropEdit(u, [
          { mime: 'text/uri-list', text: `file:///${uriList}` },
        ]),
      [cUri, picUri] as const,
    )
    expect(imgDrop).toBe('![${1:alt text}](pic.png)')

    // 10b. Drop a binary image with no disk path (screenshot-style) → written to
    // an `assets/` folder beside the markdown file and embedded. 1x1 png bytes.
    const PNG_1X1_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    const binDrop = await page.evaluate(
      ([u, b64]) =>
        window.__E2E__!.getMarkdownDropEdit(u, [
          { mime: 'image/png', base64: b64, fileName: 'clip.png' },
        ]),
      [cUri, PNG_1X1_BASE64] as const,
    )
    expect(binDrop).toMatch(/^!\[\$\{1:alt text\}\]\(assets\/image-[\d-]+\.png\)$/)

    // The asset must exist on disk under the markdown file's `assets/` folder.
    await expect
      .poll(() => (existsSync(join(dir, 'assets')) ? readdirSync(join(dir, 'assets')) : []))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^image-[\d-]+\.png$/)]))

    // 10c. The snippet a drop/paste produces is executed as a snippet (VSCode
    // gesture): inserting `[${1:text}](a.md)` expands the placeholder to `text`
    // AND leaves it selected so the user can immediately type the link label.
    const snippetState = await page.evaluate(() => {
      window.__E2E__!.setActiveEditorText('')
      return window.__E2E__!.insertMarkdownSnippet('[${1:text}](a.md)')
    })
    expect(snippetState?.text).toBe('[text](a.md)')
    expect(snippetState?.selected).toBe('text')

    // 10d. The FULL drop execution path (what a real drag-and-drop runs):
    // provider → createCombinedWorkspaceEdit → IBulkEditService.apply(edit,
    // { editor }) → SnippetController. This is the layer 10a-c don't cover, and
    // where the auto-select regression lives. Dropping a file must both insert
    // `[text](file.md)` AND leave `text` selected for immediate rename.
    const otherUri = `${dir}/other.md`
    const fileDrop = await page.evaluate(
      ([u, list]) => {
        window.__E2E__!.setActiveEditorText('')
        return window.__E2E__!.applyMarkdownDropEdit(u, [
          { mime: 'text/uri-list', text: `file:///${list}` },
        ])
      },
      [cUri, otherUri] as const,
    )
    expect(fileDrop?.text).toBe('[text](other.md)')
    expect(fileDrop?.selected).toBe('text')

    // Dropping a binary image the same way embeds it and selects `alt text`.
    const imageDrop = await page.evaluate(
      ([u, b64]) => {
        window.__E2E__!.setActiveEditorText('')
        return window.__E2E__!.applyMarkdownDropEdit(u, [
          { mime: 'image/png', base64: b64, fileName: 'clip.png' },
        ])
      },
      [cUri, PNG_1X1_BASE64] as const,
    )
    expect(imageDrop?.text).toMatch(/^!\[alt text\]\(assets\/image-[\d-]+\.png\)$/)
    expect(imageDrop?.selected).toBe('alt text')
  })
})
