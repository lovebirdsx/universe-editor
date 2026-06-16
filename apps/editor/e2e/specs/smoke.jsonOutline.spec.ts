/*---------------------------------------------------------------------------------------------
 *  JSON Outline smoke (P1).
 *
 *  Covers the JSON document-symbol provider wired by
 *  JsonLanguageFeaturesContribution: it delegates to Monaco's built-in JSON
 *  worker and registers through ILanguageFeaturesService, so the workbench
 *  Outline (the SAME IOutlineService observable the view renders) fills in for
 *  `.json` files — and "Go to Symbol in File" rides the same provider.
 *
 *  Unlike the TS/markdown outline specs, JSON symbols come from the in-renderer
 *  worker (no out-of-process LSP cold start), so resolution is fast.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

function writeWorkspace(): { dir: string; jsonPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-jsonoutline-'))
  const jsonPath = join(dir, 'pkg.json')
  writeFileSync(
    jsonPath,
    JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { build: 'tsc' } }, null, 2) + '\n',
  )
  return { dir: dir.replace(/\\/g, '/'), jsonPath: jsonPath.replace(/\\/g, '/') }
}

test.describe('@p1 json outline', () => {
  test('shows JSON property symbols in the Outline', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, jsonPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)

    // Reveal + focus the Outline view so its DOM renders.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })

    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), jsonPath)
    await expect.poll(() => workbench.getContextKey<string>('activeEditorLanguageId')).toBe('json')

    // Symbols resolve from the in-renderer JSON worker; the provider registers
    // AfterRestore, so the first pull may precede it — OutlineService retries.
    // The Monaco JSON worker still has a first-init cost; on Windows CI (2 cores,
    // contending Electron instances) it can outlast a 10s window, so match the
    // TS outline spec's 20s budget. OutlineService's retry then carries it.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 20000 })
      .toEqual(expect.arrayContaining(['name', 'version', 'scripts']))

    // The view itself must render the rows, not just the service observable.
    await expect(page.getByRole('treeitem', { name: 'scripts' })).toBeVisible({ timeout: 10000 })
  })
})
