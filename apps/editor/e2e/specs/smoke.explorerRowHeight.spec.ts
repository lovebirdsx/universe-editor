/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Explorer row height (P1).
 *  Regression guard — rows must keep their 22px height however many are on
 *  screen. The original failure was a flat list of flex children inside the flex
 *  column `.view`, where each row compressed to fit instead of overflowing, so
 *  spacing shrank as more folders were expanded. Rows are absolutely positioned
 *  now, but the row count here stays below the virtualization threshold so this
 *  still covers the path where every row is rendered at once.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/sharedApp.js'

const ROW_HEIGHT = 22
// Enough rows to overflow any reasonable viewport, but well under the 200 default
// virtualization threshold so every row is rendered rather than windowed.
const FILE_COUNT = 120

test.describe('@p1 explorer row height', () => {
  test('rows keep their height when the list overflows the viewport @regression', async ({
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-rowh-'))
    await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, i) =>
        fs.writeFile(path.join(tmpDir, `file-${String(i).padStart(3, '0')}.txt`), 'x'),
      ),
    )

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    const rows = workbench.page.locator('[role="treeitem"]')
    await expect(rows.first()).toBeVisible({ timeout: 5000 })
    // Wait until the flat list has populated (root + many children).
    await expect.poll(() => rows.count(), { timeout: 5000 }).toBeGreaterThan(30)

    // Sample a handful of rows across the list; each must keep ~ROW_HEIGHT.
    const sampleIndexes = [0, 5, 15, 25]
    for (const i of sampleIndexes) {
      const box = await rows.nth(i).boundingBox()
      expect(box, `row ${i} should have a bounding box`).not.toBeNull()
      expect(
        box!.height,
        `row ${i} height should not be compressed below ${ROW_HEIGHT}px`,
      ).toBeGreaterThanOrEqual(ROW_HEIGHT - 1)
    }

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
