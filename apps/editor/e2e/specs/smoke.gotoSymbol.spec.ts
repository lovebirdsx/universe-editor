/*---------------------------------------------------------------------------------------------
 *  Go to Symbol smoke (P1).
 *
 *  Verifies the two VSCode-style symbol pickers use OUR quick pick:
 *    1. Go to Symbol in Editor (Ctrl+Shift+O) — replaces monaco's quickOutline,
 *       opens exactly one quick pick, shows symbol-kind icons, and jumps the cursor.
 *    2. Go to Symbol in Workspace (Ctrl+T) — shows symbol-kind icons in results.
 *
 *  Both back onto the out-of-process markdown LSP, so assertions poll.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

function writeWorkspace(): { dir: string; aPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-gotosym-'))
  const aPath = join(dir, 'a.md')
  writeFileSync(aPath, '# Alpha\n\n## Beta\n\nbody\n')
  writeFileSync(join(dir, 'other.md'), '# Gamma\n\nbody\n')
  return { dir: dir.replace(/\\/g, '/'), aPath: aPath.replace(/\\/g, '/') }
}

test.describe('@p1 go to symbol', () => {
  test('Go to Symbol in Editor opens one quick pick with kind icons and jumps the cursor', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const { dir, aPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), aPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 5000 })
      .toBe('markdown')

    const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
    // Outline symbols arrive from the lazy LSP — wait before opening the picker.
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getMarkdownDocumentSymbols(u), uri), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining(['# Alpha', '## Beta']))

    // Fire-and-forget: the command awaits the picker.
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.gotoSymbol'))
    await workbench.quickInput.waitForVisible()

    // Exactly one quick pick — monaco's quickOutline default key was unbound.
    expect(await page.getByTestId('quick-input').count()).toBe(1)

    // Items carry symbol-kind icons.
    await expect
      .poll(() =>
        page.getByTestId('quick-input-item-icon-slot').first().getAttribute('data-icon-id'),
      )
      .toMatch(/^symbol-kind-/)

    // Move to the second symbol (## Beta, line 3) and accept.
    await workbench.quickInput.input.press('ArrowDown')
    await workbench.quickInput.input.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber))
      .toBe(3)
  })

  test('Go to Symbol in Workspace shows kind icons in results', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const { dir, aPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), aPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 5000 })
      .toBe('markdown')

    // Warm the server so workspace search returns results.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.queryMarkdownWorkspaceSymbols('Alpha')), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining(['# Alpha']))

    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.showAllSymbols'))
    await workbench.quickInput.waitForVisible()
    await workbench.quickInput.input.fill('Alpha')

    await expect
      .poll(
        () => page.getByTestId('quick-input-item-icon-slot').first().getAttribute('data-icon-id'),
        { timeout: 10000 },
      )
      .toMatch(/^symbol-kind-/)
  })

  test('Go to Symbol in Workspace lists symbols with no query typed', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const { dir, aPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), aPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 5000 })
      .toBe('markdown')

    // Warm the server so the empty (match-all) query has symbols to return.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.queryMarkdownWorkspaceSymbols('Alpha')), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining(['# Alpha']))

    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.showAllSymbols'))
    await workbench.quickInput.waitForVisible()

    // Nothing typed: the picker should still populate (VSCode-style match-all).
    await expect
      .poll(() => page.getByTestId('quick-input-item-icon-slot').count(), { timeout: 10000 })
      .toBeGreaterThan(0)
  })
})
