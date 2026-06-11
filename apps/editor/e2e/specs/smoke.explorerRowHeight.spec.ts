/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Explorer row height (P1).
 *  Regression guard — when many rows render in non-virtual mode (count below the
 *  virtualization threshold) the flat list lives directly inside the flex column
 *  `.view`. Without `flex-shrink: 0` each row would be compressed below its 22px
 *  height to fit the container instead of overflowing/scrolling, so spacing
 *  shrank as more folders were expanded. This asserts rows keep their height.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/electronApp.js'

const ROW_HEIGHT = 22
// Enough rows to overflow any reasonable viewport, but well under the 200 default
// virtualization threshold so we exercise the non-virtual flat-list path.
const FILE_COUNT = 120

test.describe('@p1 explorer row height', () => {
  test('rows keep their height when the list overflows the viewport', async ({ workbench }) => {
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
