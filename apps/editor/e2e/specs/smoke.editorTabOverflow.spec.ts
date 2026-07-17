/*---------------------------------------------------------------------------------------------
 *  Regression: when editor tabs overflow the tab bar, the scroll arrows must
 *  appear and the mouse wheel must scroll the tabs horizontally.
 *
 *  The original bug: every effect that wires up the tab bar's DOM (scroll +
 *  ResizeObserver listeners, the native wheel listener) ran mount-only, but on
 *  first mount a group has zero editors so the tab bar element does not exist
 *  yet — `tabBarRef.current` is null and the effects early-return forever. Once
 *  files opened past the overflow point the listeners were never attached, so
 *  the arrow-visibility state stayed false (arrows hidden) and the wheel did
 *  nothing.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p1 editor tab overflow scroll', () => {
  test('overflowing tabs show scroll arrows and respond to the wheel @regression', async ({
    page,
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-taboverflow-'))
    const names: string[] = []
    // Long names + enough files to guarantee the tab bar overflows at any
    // reasonable window width.
    for (let i = 0; i < 12; i++) {
      const n = `long-editor-tab-file-name-${String(i).padStart(2, '0')}.txt`
      names.push(n)
      await fs.writeFile(path.join(tmpDir, n), 'x')
    }

    try {
      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)
      await expect
        .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
        .toBe(true)

      const tabBar = page.locator('[data-testid="editor-group-tabbar"]')
      const leftArrow = page.locator('button[aria-label="Scroll tabs left"]')
      const rightArrow = page.locator('button[aria-label="Scroll tabs right"]')

      // Open files one-by-one (the exact reproduction: adding a tab grows the
      // bar's scrollWidth without resizing its box).
      for (let i = 0; i < names.length; i++) {
        const fsPath = path.join(tmpDir, names[i]!).replace(/\\/g, '/')
        await page.evaluate((p) => window.__E2E__!.openFileUri(p, { pinned: true }), fsPath)
        await expect
          .poll(() => workbench.getActiveEditorUri(), { timeout: 5000 })
          .toContain(names[i]!)
        if (i === 0) await expect(tabBar).toBeVisible({ timeout: 5000 })
      }

      // Sanity: the tab bar really overflows now.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const bar = document.querySelector<HTMLElement>(
                '[data-testid="editor-group-tabbar"]',
              )!
              return bar.scrollWidth > bar.clientWidth
            }),
          { timeout: 5000 },
        )
        .toBe(true)

      // Opening the last file scrolls the active (right-most) tab into view, so
      // the bar is scrolled away from the start → the LEFT arrow must be shown.
      await expect(leftArrow).toBeVisible({ timeout: 5000 })

      // Scrolling all the way back to the start must reveal the RIGHT arrow and
      // hide the left one — proving the scroll listener keeps arrow state live.
      await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('[data-testid="editor-group-tabbar"]')!
        bar.scrollLeft = 0
        bar.dispatchEvent(new Event('scroll'))
      })
      await expect(rightArrow).toBeVisible({ timeout: 5000 })
      await expect(leftArrow).toBeHidden({ timeout: 5000 })

      // The mouse wheel (vertical delta) must scroll the tabs horizontally.
      const before = await page.evaluate(
        () =>
          document.querySelector<HTMLElement>('[data-testid="editor-group-tabbar"]')!.scrollLeft,
      )
      await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('[data-testid="editor-group-tabbar"]')!
        const r = bar.getBoundingClientRect()
        bar.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: 200,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          }),
        )
      })
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                document.querySelector<HTMLElement>('[data-testid="editor-group-tabbar"]')!
                  .scrollLeft,
            ),
          { timeout: 5000 },
        )
        .toBeGreaterThan(before)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
