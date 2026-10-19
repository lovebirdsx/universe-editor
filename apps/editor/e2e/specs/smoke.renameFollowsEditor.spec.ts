/*---------------------------------------------------------------------------------------------
 *  Smoke spec: renaming/moving an open file (or a folder containing it) in the
 *  Explorer keeps its tab alive and retargets it to the new path. Before the
 *  fix the watcher saw the rename as "old path deleted" and closed the tab.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p1 explorer rename follows open editors', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'a.txt'), 'alpha\n')
        writeFileSync(join(dir, 'b.txt'), 'beta\n')
        mkdirSync(join(dir, 'folder'))
        writeFileSync(join(dir, 'folder', 'nested.txt'), 'nested\n')
      },
    },
  })

  test('keeps an open dirty file tab on the renamed path', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const dir = (await workbench.getCurrentWorkspacePath())!
    const aPath = join(dir, 'a.txt')
    const bPath = join(dir, 'b.txt')

    await page.evaluate((p) => window.__E2E__!.openFileUri(p), aPath)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), bPath)
    // Re-open a.txt to activate it without changing tab order.
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), aPath)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('a.txt')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorText('alpha edited\n')))
      .toBe(true)
    await expect.poll(() => page.evaluate(() => window.__E2E__!.isActiveEditorDirty())).toBe(true)

    const before = await page.evaluate(() => window.__E2E__!.getActiveGroupEditorUris())
    expect(before).toHaveLength(2)

    const renamedUri = await page.evaluate(
      ([p, name]) => window.__E2E__!.renameExplorerResource(p, name),
      [aPath, 'renamed.txt'] as const,
    )

    // Same slot, same active tab, now pointing at the new URI.
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(renamedUri)
    const after = await page.evaluate(() => window.__E2E__!.getActiveGroupEditorUris())
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(renamedUri)
    expect(after[1]?.endsWith('/b.txt')).toBe(true)

    // The dirty buffer and its content survive the retarget.
    expect(await page.evaluate(() => window.__E2E__!.isActiveEditorDirty())).toBe(true)
    await expect.poll(() => workbench.getActiveEditorText()).toBe('alpha edited\n')

    // Saving writes the new path, not the old one.
    await workbench.runCommand('workbench.action.files.save')
    await expect.poll(() => readFileSync(join(dir, 'renamed.txt'), 'utf8')).toBe('alpha edited\n')
    await expect.poll(() => page.evaluate(() => window.__E2E__!.isActiveEditorDirty())).toBe(false)
  })

  test('retargets a file tab when its parent folder is renamed', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const dir = (await workbench.getCurrentWorkspacePath())!
    const folderPath = join(dir, 'folder')
    const nestedPath = join(folderPath, 'nested.txt')

    // The row must be materialized so the Explorer knows this path is a
    // directory and fires a directory rename operation.
    await expect(page.locator('[role="treeitem"]', { hasText: 'folder' })).toBeVisible({
      timeout: 10000,
    })
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), nestedPath)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('nested.txt')

    const renamedFolderUri = await page.evaluate(
      ([p, name]) => window.__E2E__!.renameExplorerResource(p, name),
      [folderPath, 'renamed-folder'] as const,
    )

    await expect.poll(() => workbench.getActiveEditorUri()).toBe(`${renamedFolderUri}/nested.txt`)
    await expect.poll(() => workbench.getActiveEditorText()).toBe('nested\n')
    expect(await page.evaluate(() => window.__E2E__!.getActiveGroupEditorCount())).toBe(1)
  })
})
