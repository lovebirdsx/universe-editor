/*---------------------------------------------------------------------------------------------
 *  Outline keyboard navigation smoke (P1).
 *
 *  Verifies the REAL keyboard path the unit tests can't reach: arrows / Enter go
 *  through the focused Tree, while Ctrl+J/K/H/L must survive the global
 *  keybinding handler — which would otherwise claim Ctrl+J (toggle panel),
 *  Ctrl+K (chord leader), Ctrl+H (replace) and Ctrl+L (line select). The
 *  window-capture ctrlNavigationRegistry claims them while the tree holds DOM
 *  focus. Ctrl+P/N are NOT outline aliases: they stay with Quick Open / New File.
 *
 *  Uses JSON symbols (in-renderer worker, no LSP cold start) for a fast, stable
 *  tree. `scripts` is an expandable row (child `build`), so we can exercise
 *  expand/collapse + descend/ascend.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

function writeWorkspace(): { dir: string; jsonPath: string } {
  const dir = mkTempDir('universe-editor-e2e-outlinekbd-')
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
  test('arrows drive the outline; Ctrl+P stays global', async ({ page, workbench }) => {
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

    // ArrowDown → down.
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['scripts'])
    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(false)

    // ArrowUp → up, back to version.
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['version'])
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['scripts'])

    // Collapse via ArrowLeft, then re-expand + descend via ArrowRight.
    await page.keyboard.press('ArrowLeft')
    await expect(outline.getByRole('treeitem', { name: 'build' })).toHaveCount(0)
    await page.keyboard.press('ArrowRight')
    await expect(outline.getByRole('treeitem', { name: 'build' })).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['build'])
    // ArrowLeft from the child steps back to the parent.
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['scripts'])

    // The filter box is editable, so the tree's React handler ignores the
    // stroke; Ctrl+J/K/H/L keep their global meaning. `i` matches scripts and
    // build, so the pruned tree keeps both.
    await page.keyboard.press('i')
    // Scope to the Outline's part: the Output panel has a "Filter" placeholder too.
    const filter = page.getByTestId('part-secondarysidebar').getByPlaceholder('Filter')
    await expect(filter).toBeFocused()
    await expect(filter).toHaveValue('i')

    // Ctrl+J now toggles the panel and must not move the outline selection.
    await page.keyboard.press('Control+j')
    await expect.poll(() => page.evaluate(selectedName)).toEqual(['scripts'])
    await expect(filter).toHaveValue('i')

    // Ctrl+P is a plain global command again: Quick Open opens even while the
    // filter input has focus.
    await page.keyboard.press('Control+p')
    await expect
      .poll(() => workbench.getContextKey<boolean>('quickInputVisible'), { timeout: 5000 })
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(false)
    await expect(filter).toHaveValue('i')
  })
})
