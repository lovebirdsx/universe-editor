/*---------------------------------------------------------------------------------------------
 *  Peek widget keyboard navigation smoke (P1).
 *
 *  Opens the cross-file definition peek (Peek Definition / Alt+F12) and drives it
 *  with the REAL keyboard, mirroring VSCode:
 *    - the peek focuses its reference tree, so pressing Enter follows the selected
 *      reference to the target file (closing the peek).
 *
 *  Backs onto the out-of-process markdown LSP, so assertions poll. This guards the
 *  keyboard path specifically — the mouse path (click preview / double-click jump)
 *  goes through a different code path and is exercised manually.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/coreMarkdownApp.js'

function writeWorkspace(): { dir: string; aPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-peeknav-'))
  const aPath = join(dir, 'a.md')
  // The link target on line 5 resolves cross-file to other.md (heading gamma).
  writeFileSync(aPath, '# Alpha\n\n## Beta\n\n[cross](other.md#gamma)\n\nbody\n')
  writeFileSync(join(dir, 'other.md'), '# Gamma\n\nbody\n')
  return { dir: dir.replace(/\\/g, '/'), aPath: aPath.replace(/\\/g, '/') }
}

test.describe('@p1 peek keyboard navigation', () => {
  test('Enter in the definition peek follows the reference to the target file', async ({
    page,
    workbench,
  }) => {
    // Out-of-process LSP warmup is slow on CI; give the cold start headroom.
    test.slow()
    await workbench.waitForRestored()

    const { dir, aPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), aPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
    expect(uri).toContain('a.md')

    // Definition must be resolvable before we open the peek (lazy LSP warmup).
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getMarkdownDefinition(u, 5, 12), uri), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining([expect.stringContaining('other.md')]))

    // Put the cursor inside the link, then open the definition peek.
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(5, 12))
    await page.evaluate(() => void window.__E2E__!.runCommand('editor.action.peekDefinition'))

    // The peek opens asynchronously and focuses its reference tree; pressing
    // Enter there must follow to other.md. Gate the press on the tree actually
    // holding focus — pressing Enter before the peek mounts lands in the editor
    // textarea and inserts a newline at the cursor, splitting the link and
    // wedging the (already in-flight) definition resolution so the peek never
    // opens. On slow CI the peek mounts later, so the blind press was racing it.
    // CI cold start (LSP warmup + peek mount) can outlast 10s; widen the poll
    // window there — test.slow() already grants the headroom.
    await expect
      .poll(
        async () => {
          if (await page.evaluate(() => window.__E2E__!.isReferencePeekFocused())) {
            await page.keyboard.press('Enter')
          }
          return page.evaluate(() => window.__E2E__!.getActiveEditorUri())
        },
        {
          timeout: process.env['CI'] ? 20000 : 10000,
          intervals: [250, 250, 500, 500, 1000],
        },
      )
      .toContain('other.md')
  })
})
