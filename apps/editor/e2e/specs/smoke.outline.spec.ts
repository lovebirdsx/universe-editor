/*---------------------------------------------------------------------------------------------
 *  Outline view smoke (P1).
 *
 *  Regression for "the Outline shows the first file's symbols, but goes empty
 *  after switching to another file". Unlike smoke.markdownLsp (which pulls the
 *  provider directly), this drives IOutlineService — the SAME observable the
 *  Outline view renders — through its attach/re-pull logic across a file switch.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

function writeWorkspace(): { dir: string; aPath: string; bPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-outline-'))
  const aPath = join(dir, 'a.ts')
  const bPath = join(dir, 'b.ts')
  // A real tsconfig puts tsserver in *project* mode (loads the whole program),
  // unlike the inferred single-file mode you get with loose files — this is the
  // configuration that surfaces the "outline empties on file switch" bug.
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext' }, include: ['*.ts'] }),
  )
  writeFileSync(
    aPath,
    "import { bravo } from './b'\nexport const alpha = bravo\nexport function alphaFn() {}\n",
  )
  writeFileSync(bPath, 'export const bravo = 2\nexport function bravoFn() {}\n')
  return {
    dir: dir.replace(/\\/g, '/'),
    aPath: aPath.replace(/\\/g, '/'),
    bPath: bPath.replace(/\\/g, '/'),
  }
}

test.describe('@p1 outline view', () => {
  test('keeps showing symbols after switching files', async ({ page, workbench }) => {
    // Cold tsserver start on CI can exceed the 30s default — the spec already
    // polls with a 20s budget per step (and OutlineService retries for 180s).
    // Triple the test timeout so a slow cold start doesn't kill it mid-poll.
    test.slow()
    await workbench.waitForRestored()

    const { dir, aPath, bPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)

    // Reveal + focus the Outline view in the secondary sidebar so its DOM renders.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })

    // First file: the Outline fills in once tsserver has analysed it (cold start).
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), aPath)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 20000 })
      .toEqual(expect.arrayContaining(['alpha', 'alphaFn']))
    // The view itself must render the rows (not just the service observable).
    await expect(page.getByRole('treeitem', { name: 'alphaFn' })).toBeVisible({ timeout: 10000 })

    // Switch to the second file: both the service AND the rendered tree must update.
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), bPath)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineUri()), { timeout: 20000 })
      .toContain('b.ts')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 20000 })
      .toEqual(expect.arrayContaining(['bravo', 'bravoFn']))
    await expect(page.getByRole('treeitem', { name: 'bravoFn' })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('treeitem', { name: 'alphaFn' })).toHaveCount(0)

    // Switch back to the first file: symbols must still resolve and render.
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), aPath)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 20000 })
      .toEqual(expect.arrayContaining(['alpha', 'alphaFn']))
    await expect(page.getByRole('treeitem', { name: 'alphaFn' })).toBeVisible({ timeout: 10000 })
  })
})
