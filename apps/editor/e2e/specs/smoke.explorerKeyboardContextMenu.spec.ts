/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Explorer keyboard context menu (regression guard).
 *
 *  Guard: pressing the ContextMenu key opens ONE context menu anchored at the
 *  focused row. On Windows, Chromium supplements the key press with a native
 *  `contextmenu` on keyup — detail 0, target = the focused tree container,
 *  (0,0) coords — which keydown's preventDefault cannot cancel. The tree must
 *  swallow it, otherwise a second, row-less menu opens at a fixed position.
 *  Linux Chromium (xvfb/CI) emits no such supplement at all, so a capture
 *  listener records every contextmenu the press produces and the spec asserts
 *  the contract per-platform (exact on win32, 0..1 swallowable events
 *  elsewhere): if a future Chromium changes the supplement, the assertion
 *  fails loudly instead of the swallow gate silently rotting.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/sharedApp.js'

// After a workspace change the workbench opens a ~1.5s window during which it
// restores focus to the active editor on any editor/group change (see
// WorkspaceFocusRestoreContribution). Same steady-state wait as
// smoke.explorerSelection so the keyboard press lands on the tree, not mid-restore.
const RESTORE_WINDOW_MS = 1700

interface CapturedContextMenu {
  readonly detail: number
  readonly clientX: number
  readonly clientY: number
  readonly targetRole: string | null
  readonly targetRowKey: string | null
}

test.describe('@p1 explorer keyboard context menu', () => {
  test('ContextMenu key opens a single row-anchored menu @regression', async ({
    workbench,
    page,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-kcm-'))
    await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'a')
    await fs.writeFile(path.join(tmpDir, 'beta.txt'), 'b')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    const alpha = page.locator('[role="treeitem"]', { hasText: 'alpha.txt' })
    await expect(alpha).toBeVisible({ timeout: 5000 })

    // Click selects alpha and gives the tree container DOM focus. The click's
    // preview-open lands inside the post-workspace focus-restore window, which
    // pulls focus back to the editor — wait it out and click again so the
    // steady-state focus sits on the tree (same as smoke.explorerSelection).
    await alpha.click()
    await expect(alpha).toHaveAttribute('aria-selected', 'true')
    const tree = page.locator('[role="tree"]').filter({ has: alpha }).first()
    await page.waitForTimeout(RESTORE_WINDOW_MS)
    await alpha.click()
    await expect(tree).toHaveAttribute('data-focused', 'true')

    // Record every contextmenu the press produces — verifies the Chromium
    // contract the swallow gate relies on (see file header).
    await page.evaluate(() => {
      const w = window as unknown as { __kcmLog?: CapturedContextMenu[] }
      w.__kcmLog = []
      document.addEventListener(
        'contextmenu',
        (e) => {
          const t = e.target as HTMLElement | null
          w.__kcmLog?.push({
            detail: e.detail,
            clientX: e.clientX,
            clientY: e.clientY,
            targetRole: t?.getAttribute?.('role') ?? null,
            targetRowKey: t?.closest?.('[data-row-key]')?.getAttribute?.('data-row-key') ?? null,
          })
        },
        true,
      )
    })

    await page.keyboard.press('ContextMenu')

    const menus = page.getByRole('menu')
    await expect(menus).toHaveCount(1)

    // Row-level menu (target = alpha.txt, not the empty-area fallback): the
    // row-gated entries are present.
    await expect(menus.getByRole('menuitem', { name: 'Rename…' })).toBeVisible()
    await expect(menus.getByRole('menuitem', { name: 'Delete' })).toBeVisible()

    // The menu anchors below the focused row (Tree dispatches at the row's
    // bottom-left corner), not at a fixed viewport position.
    const rowBox = await alpha.boundingBox()
    const menuBox = await menus.boundingBox()
    expect(rowBox).not.toBeNull()
    expect(menuBox).not.toBeNull()
    if (rowBox && menuBox) {
      expect(Math.abs(menuBox.x - rowBox.x)).toBeLessThanOrEqual(60)
      expect(menuBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 10)
      expect(menuBox.y).toBeLessThanOrEqual(rowBox.y + rowBox.height + 80)
    }

    // The native keyup supplement is Windows-only: Chromium re-dispatches a
    // detail-0 contextmenu (target = the focused tree container) on the
    // ContextMenu key's keyup there, and keydown's preventDefault can't cancel
    // it — the tree's detail-0 guard swallows it. Linux Chromium (xvfb/CI)
    // produces no supplement at all (CI-verified), so assert per-platform:
    // exact on win32 (the swallow gate's real battlefront), at most one
    // swallowable event elsewhere — a future Chromium contract change still
    // fails loudly here instead of silently rotting the gate.
    const log = await page.evaluate(
      () => (window as unknown as { __kcmLog?: CapturedContextMenu[] }).__kcmLog,
    )
    expect(log?.filter((e) => e.detail === 1 && e.targetRowKey !== null)).toHaveLength(1)
    const native = (log ?? []).filter((e) => e.detail === 0)
    if (process.platform === 'win32') {
      expect(native).toHaveLength(1)
      expect(native[0]?.targetRole).toBe('tree')
    } else {
      expect(native.length).toBeLessThanOrEqual(1)
      if (native[0]) {
        expect(native[0].targetRole).toBe('tree')
      }
    }

    // Mouse right-click on another row: still exactly one menu, and the target
    // row switches.
    await page.keyboard.press('Escape')
    await expect(menus).toHaveCount(0)

    const beta = page.locator('[role="treeitem"]', { hasText: 'beta.txt' })
    await beta.click({ button: 'right' })
    await expect(menus).toHaveCount(1)
    await expect(menus.getByRole('menuitem', { name: 'Rename…' })).toBeVisible()
    await expect(beta).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
