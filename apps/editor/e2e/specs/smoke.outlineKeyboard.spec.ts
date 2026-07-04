/*---------------------------------------------------------------------------------------------
 *  Outline keyboard navigation smoke (P1).
 *
 *  Verifies the REAL keyboard path the unit tests can't reach: arrows / Enter go
 *  through the focused Tree, while the emacs Ctrl+P/N/B/F aliases must survive the
 *  global keybinding handler — which claims Ctrl+P (quick open) / Ctrl+N (new file)
 *  in the document capture phase for every other focus. They only reach the
 *  outline navigator because their bindings are gated on
 *  `focusedView == 'workbench.view.outline.main'` and registered to win the tie.
 *
 *  Uses JSON symbols (in-renderer worker, no LSP cold start) for a fast, stable
 *  tree. `scripts` is an expandable row (child `build`), so we can exercise
 *  expand/collapse + descend/ascend.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

function writeWorkspace(): { dir: string; jsonPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-outlinekbd-'))
  const jsonPath = join(dir, 'pkg.json')
  writeFileSync(
    jsonPath,
    JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { build: 'tsc' } }, null, 2) + '\n',
  )
  return { dir: dir.replace(/\\/g, '/'), jsonPath: jsonPath.replace(/\\/g, '/') }
}

const selectedName = () => {
  const tree = document.querySelector('[role="tree"][aria-label="Outline"]')
  if (!tree) return ['<no-outline-tree>']
  return Array.from(tree.querySelectorAll('[role="treeitem"]'))
    .filter((r) => r.getAttribute('aria-selected') === 'true')
    .map((r) => r.lastElementChild?.textContent ?? '')
}

test.describe('@p1 outline keyboard navigation', () => {
  test('arrows and emacs Ctrl+P/N/B/F drive the outline selection', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, jsonPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), jsonPath)

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 20000 })
      .toEqual(expect.arrayContaining(['name', 'version', 'scripts', 'build']))
    const outline = page.getByRole('tree', { name: 'Outline' })
    await expect(outline.getByRole('treeitem', { name: 'scripts' })).toBeVisible({ timeout: 10000 })

    // Focus the outline tree so keys route to it / to the focusedView-gated commands.
    await page.evaluate(() => window.__E2E__!.runCommand('outline.focus'))
    await expect
      .poll(() => workbench.getContextKey<string>('focusedView'))
      .toBe('workbench.view.outline.main')

    // Focusing selects the first row (name).
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['name'])

    // ArrowDown → version (bare arrow reaches the tree directly).
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['version'])

    // Ctrl+N → down. This is the critical assertion: globally Ctrl+N is New File;
    // it must NOT create an untitled editor here, only move the outline selection.
    await page.keyboard.press('Control+n')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['scripts'])

    // Ctrl+P → up, back to version (globally quick open — must not open it).
    await page.keyboard.press('Control+p')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['version'])
    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(false)

    // Down to the expandable `scripts` row, then Ctrl+F to expand and descend.
    await page.keyboard.press('Control+n')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['scripts'])
    // Collapse via Ctrl+B, then re-expand + descend via Ctrl+F.
    await page.keyboard.press('Control+b')
    await expect(outline.getByRole('treeitem', { name: 'build' })).toHaveCount(0)
    await page.keyboard.press('Control+f')
    await expect(outline.getByRole('treeitem', { name: 'build' })).toBeVisible()
    await page.keyboard.press('Control+f')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['build'])
    // Ctrl+B from the child steps back to the parent.
    await page.keyboard.press('Control+b')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['scripts'])
  })
})
