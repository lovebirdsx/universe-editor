/*---------------------------------------------------------------------------------------------
 *  Go to Symbol smoke (P1).
 *
 *  Verifies the two VSCode-style symbol pickers use OUR quick pick:
 *    1. Go to Symbol in Editor (Ctrl+Shift+O) — replaces monaco's quickOutline,
 *       opens exactly one quick pick, shows symbol icons, and jumps the cursor.
 *    2. Go to Symbol in Workspace (Ctrl+T) — no live match-all before the first
 *       search (VSCode parity), kind icons in results, and the last search's
 *       results are reused when reopening with nothing typed.
 *
 *  The fixtures are markdown, whose headings carry the `symbol-heading` icon id;
 *  other kinds use `symbol-kind-<n>`. Both back onto the out-of-process markdown
 *  LSP, so assertions poll.
 *
 *  One journey over one cold launch: the workspace-picker steps must run in this
 *  exact order anyway (the "empty before any search" assertion only holds before
 *  the first picker search populates the cache), and every extra test here costs
 *  a full Electron + LSP cold start.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/markdownApp.js'

function writeWorkspace(): { dir: string; aPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-gotosym-'))
  const aPath = join(dir, 'a.md')
  writeFileSync(aPath, '# Alpha\n\n## Beta\n\nbody\n')
  writeFileSync(join(dir, 'other.md'), '# Gamma\n\nbody\n')
  return { dir: dir.replace(/\\/g, '/'), aPath: aPath.replace(/\\/g, '/') }
}

test.describe('@p1 go to symbol', () => {
  test('editor picker jumps the cursor; workspace picker gates match-all and shows kind icons', async ({
    page,
    workbench,
  }) => {
    // Backs onto the out-of-process markdown LSP; cold start is slow on
    // contended CI runners and the journey chains both pickers.
    test.setTimeout(120_000)
    await workbench.waitForRestored()

    const { dir, aPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), aPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 10000 })
      .toBe('markdown')

    const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
    // Warm the lazy LSP on both fronts before opening any picker: document
    // symbols back the editor picker, workspace symbols back Ctrl+T. (The probe
    // queries the server directly and does NOT seed the picker's own cache.)
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getMarkdownDocumentSymbols(u), uri), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining(['# Alpha', '## Beta']))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.queryMarkdownWorkspaceSymbols('Alpha')), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining(['# Alpha']))

    await test.step('Go to Symbol in Editor opens one quick pick with kind icons and jumps the cursor', async () => {
      // Fire-and-forget: the command awaits the picker.
      await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.gotoSymbol'))
      await workbench.quickInput.waitForVisible()

      // Exactly one quick pick — monaco's quickOutline default key was unbound.
      expect(await page.getByTestId('quick-input').count()).toBe(1)

      // Items carry symbol icons (markdown headings → symbol-heading).
      await expect
        .poll(() =>
          page.getByTestId('quick-input-item-icon-slot').first().getAttribute('data-icon-id'),
        )
        .toMatch(/^(symbol-kind-|symbol-heading$)/)

      // Move to the second symbol (## Beta, line 3) and accept.
      await workbench.quickInput.input.press('ArrowDown')
      await workbench.quickInput.input.press('Enter')
      await workbench.quickInput.waitForHidden()

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber))
        .toBe(3)
    })

    // VSCode parity: no live match-all on an empty query. The first open shows
    // nothing; once a search has run, reopening (or clearing the filter) reuses
    // the last search's results. This step MUST precede any picker search —
    // the editor picker above uses a separate provider and doesn't seed the cache.
    await test.step('workspace picker shows nothing on an empty query before any search ran', async () => {
      await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.showAllSymbols'))
      await workbench.quickInput.waitForVisible()

      // showAllSymbols prefills the '#' prefix; keep it so the workspace-symbol
      // provider stays active (a bare 'Alpha' would route to file search).
      await workbench.quickInput.input.fill('#')
      await page.waitForTimeout(500) // past the provider debounce (150ms)
      expect(await page.getByTestId('quick-input-item-icon-slot').count()).toBe(0)
    })

    await test.step('a workspace search shows results with kind icons', async () => {
      await workbench.quickInput.input.fill('#Alpha')
      await expect
        .poll(
          () => page.getByTestId('quick-input-item-icon-slot').first().getAttribute('data-icon-id'),
          { timeout: 10000 },
        )
        .toMatch(/^(symbol-kind-|symbol-heading$)/)
      await workbench.quickInput.input.press('Escape')
      await workbench.quickInput.waitForHidden()
    })

    await test.step('reopening with nothing typed reuses the last search results', async () => {
      await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.showAllSymbols'))
      await workbench.quickInput.waitForVisible()
      await workbench.quickInput.input.fill('#')
      await expect
        .poll(() => page.getByTestId('quick-input-item-icon-slot').count(), { timeout: 10000 })
        .toBeGreaterThan(0)
    })
  })
})
