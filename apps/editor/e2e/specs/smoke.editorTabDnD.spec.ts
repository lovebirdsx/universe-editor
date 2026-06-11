/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Editor Tab DnD — drag a tab to another group (P1).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p1 editor tab drag-and-drop', () => {
  test('drag tab to another group moves the editor', async ({ workbench }) => {
    // Create a temp workspace with two files.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-tabdnd-'))
    const alphaPath = path.join(tmpDir, 'alpha.txt')
    const betaPath = path.join(tmpDir, 'beta.txt')
    await fs.writeFile(alphaPath, 'alpha')
    await fs.writeFile(betaPath, 'beta')

    try {
      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)

      await expect
        .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
        .toBe(true)

      // Open alpha.txt in the default group.
      await workbench.page.evaluate(
        ([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: true }),
        [alphaPath.replace(/\\/g, '/')] as const,
      )
      await expect
        .poll(() => workbench.getActiveEditorUri(), { timeout: 5000 })
        .toContain('alpha.txt')

      // Split the editor to create a second group.
      await workbench.runCommand('workbench.action.splitEditorRight')
      await expect.poll(() => workbench.getEditorGroupCount(), { timeout: 5000 }).toBe(2)

      // Wait for the second group to appear in the DOM before opening beta.txt.
      const tabBars = workbench.page.locator('[data-testid="editor-group-tabbar"]')
      await expect(tabBars).toHaveCount(2, { timeout: 5000 })

      // Open beta.txt in the second group.
      await workbench.page.evaluate(
        ([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: true }),
        [betaPath.replace(/\\/g, '/')] as const,
      )
      await expect
        .poll(() => workbench.getActiveEditorUri(), { timeout: 5000 })
        .toContain('beta.txt')

      const firstTabBar = tabBars.nth(0)
      const secondTabBar = tabBars.nth(1)

      // beta.txt tab should be in the second group.
      const betaTab = secondTabBar.locator('[role="tab"]', { hasText: 'beta.txt' })
      await expect(betaTab).toBeVisible({ timeout: 3000 })

      // Wait until the first group's body has a real layout box before dropping on
      // its center. On headless CI the freshly-split group can briefly report a
      // zero-area rect, which would otherwise make the center drop misfire.
      const firstBody = workbench.page.locator('[data-testid="editor-group-body"]').nth(0)
      await expect
        .poll(
          async () => {
            const box = await firstBody.boundingBox()
            return box ? Math.min(box.width, box.height) : 0
          },
          { timeout: 5000 },
        )
        .toBeGreaterThan(0)

      // Dispatch native HTML5 drag events directly: dragstart on the source tab,
      // then drop onto the *body* (center) of the first group — equivalent to a
      // tab-bar drop visually but exercises the body drop branch. We intentionally
      // omit dragenter/dragover: a robust drop handler must not silently no-op
      // just because internal scratch state happens to be uninitialized (real
      // browsers always fire them, but a drop event already carries coordinates).
      await workbench.page.evaluate(() => {
        const bars = document.querySelectorAll<HTMLElement>('[data-testid="editor-group-tabbar"]')
        const bodies = document.querySelectorAll<HTMLElement>('[data-testid="editor-group-body"]')
        const source = Array.from(
          bars[1]?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
        ).find((t) => (t.textContent ?? '').includes('beta.txt'))
        const target = bodies[0]
        if (!source || !target) throw new Error('drag source/target missing')

        const dt = new DataTransfer()
        const fire = (el: HTMLElement, type: string, clientX: number, clientY: number) => {
          const ev = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX,
            clientY,
            dataTransfer: dt,
          })
          el.dispatchEvent(ev)
        }
        const sRect = source.getBoundingClientRect()
        const tRect = target.getBoundingClientRect()
        const sx = sRect.left + sRect.width / 2
        const sy = sRect.top + sRect.height / 2
        const tx = tRect.left + tRect.width / 2
        const ty = tRect.top + tRect.height / 2

        fire(source, 'dragstart', sx, sy)
        fire(target, 'drop', tx, ty)
        fire(source, 'dragend', tx, ty)
      })

      // Now both files should be in the first group.
      const betaTabInSecond = secondTabBar.locator('[role="tab"]', { hasText: 'beta.txt' })
      await expect(betaTabInSecond).toBeHidden({ timeout: 3000 })

      const betaTabInFirst = firstTabBar.locator('[role="tab"]', { hasText: 'beta.txt' })
      await expect(betaTabInFirst).toBeVisible({ timeout: 3000 })
    } finally {
      // The Electron app is still holding this workspace open here (the fixture
      // closes it only after the test returns): the two opened files plus the
      // chokidar directory watcher keep transient handles on tmpDir, so on
      // Windows rmdir can hit EBUSY. maxRetries/retryDelay rides out that window
      // (force only swallows ENOENT, not EBUSY).
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
