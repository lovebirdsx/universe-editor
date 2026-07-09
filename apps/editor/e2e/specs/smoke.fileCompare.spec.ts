/*---------------------------------------------------------------------------------------------
 *  Explorer file comparison (@p1).
 *
 *  Repro for "diff opens but both sides show the same file". Comparing two distinct
 *  files must render a cross-file diff whose left side is file A and right side is
 *  file B.
 *
 *  The bug: DiffLiveContentSyncContribution keeps a *same-file* diff's modified
 *  side in sync with its originalUri's live editor model. For a cross-file compare
 *  it wrongly matched too — so once file A (the left/original side) was open in an
 *  editor, opening an A↔B compare clobbered the modified (B) side with A's content,
 *  making both sides show A. Selecting both files in the tree then "Compare
 *  Selected" opens A as a preview first, so it reliably triggered the bug.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LEFT_CONTENT = 'left file\nalpha\nbeta\ngamma'
const RIGHT_CONTENT = 'right file\ndelta\nepsilon\nzeta'

function fsPathToUriComponents(fsPath: string) {
  const forwardSlash = fsPath.replace(/\\/g, '/')
  const path = forwardSlash.startsWith('/') ? forwardSlash : '/' + forwardSlash
  return { scheme: 'file', authority: '', path, query: '', fragment: '' }
}

test.describe('@p1 explorer file compare', () => {
  test('Compare with Selected diffs two distinct files (not the same file twice)', async ({
    workbench,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ue2-filecompare-'))
    const leftPath = join(dir, 'left.txt')
    const rightPath = join(dir, 'right.txt')
    writeFileSync(leftPath, LEFT_CONTENT, 'utf8')
    writeFileSync(rightPath, RIGHT_CONTENT, 'utf8')

    await workbench.waitForRestored()
    await workbench.openWorkspace(dir)

    const left = fsPathToUriComponents(leftPath)
    const right = fsPathToUriComponents(rightPath)

    // Select left for compare, then compare the right file against it.
    await workbench.runCommand('selectForCompare', { target: left })
    await workbench.runCommand('compareSelected', { target: right })

    // The diff editor's live models are the on-screen truth.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveDiffContent()), {
        timeout: 10_000,
      })
      .toBeTruthy()

    const content = await workbench.page.evaluate(() => window.__E2E__!.getActiveDiffContent())
    expect(content?.original).toBe(LEFT_CONTENT)
    expect(content?.modified).toBe(RIGHT_CONTENT)
  })

  test('Compare Selected (two files selected in the tree) diffs the two distinct files', async ({
    workbench,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ue2-filecompare2-'))
    const leftPath = join(dir, 'left.txt')
    const rightPath = join(dir, 'right.txt')
    writeFileSync(leftPath, LEFT_CONTENT, 'utf8')
    writeFileSync(rightPath, RIGHT_CONTENT, 'utf8')

    await workbench.waitForRestored()
    await workbench.openWorkspace(dir)

    const page = workbench.page

    // Both files must be visible in the Explorer tree.
    const leftRow = page.locator('[role="treeitem"]', { hasText: 'left.txt' })
    const rightRow = page.locator('[role="treeitem"]', { hasText: 'right.txt' })
    await expect(leftRow).toBeVisible({ timeout: 8_000 })
    await expect(rightRow).toBeVisible({ timeout: 8_000 })

    // Select both: click the first, Ctrl+click the second (multi-select).
    await leftRow.click()
    await rightRow.click({ modifiers: ['Control'] })

    // Compare Selected — the path that reads tree.selection.
    await workbench.runCommand('workbench.files.action.compareFiles')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()), { timeout: 10_000 })
      .toBeTruthy()

    const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
    // The bug: both sides render the same file. Assert the two sides differ and
    // match their respective files.
    expect(content?.original).not.toBe(content?.modified)
    expect([LEFT_CONTENT, RIGHT_CONTENT]).toContain(content?.original)
    expect([LEFT_CONTENT, RIGHT_CONTENT]).toContain(content?.modified)
  })
})
