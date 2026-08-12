/*---------------------------------------------------------------------------------------------
 *  S4 — ActivityBar switches SideBar view containers (P0).
 *
 *  点击 Explorer / Search 项, SideBar 的 data-active-view-container
 *  应跟随变化; 再次点击当前激活项则关闭(VSCode 行为).
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

const EXPLORER = 'workbench.view.explorer'
const SEARCH = 'workbench.view.search'

test.describe('@p0 activitybar', () => {
  test('switches between Explorer and Search containers', async ({ workbench }) => {
    const { activityBar, sideBar } = workbench

    // The renderer's per-workspace view reconcile is fire-and-forget AFTER mount
    // (main.tsx) with a 500ms internal fallback timer. It ends by destructively
    // re-seeding the default (Explorer) active container. `whenRestored` (which
    // resetWindow awaits) fires at mount — BEFORE that reconcile — so on a slow
    // frame the reconcile lands right after our click(SEARCH) and clobbers it
    // back to Explorer (stuck value, never recovers). Gate on the reconcile
    // being settled before driving the activity bar.
    await workbench.waitForBootstrapFocusSettled()

    await expect(activityBar.item(EXPLORER)).toBeVisible()
    await expect(activityBar.item(SEARCH)).toBeVisible()

    // Explorer is auto-selected by default; click switches to Search.
    await activityBar.click(SEARCH)
    await expect(sideBar.root).toHaveAttribute('data-active-view-container', SEARCH)
    // Clicking the icon also focuses the view's primary input, like ctrl+shift+f.
    await expect(sideBar.root.getByRole('textbox', { name: 'Search' })).toBeFocused()

    await activityBar.click(EXPLORER)
    await expect(sideBar.root).toHaveAttribute('data-active-view-container', EXPLORER)

    // 再次点击当前激活项 = 关闭
    await activityBar.click(EXPLORER)
    await expect(sideBar.root).not.toHaveAttribute('data-active-view-container', EXPLORER)
  })

  // The core fixture runs with `extensions: []`, so the perforce extension
  // never activates and no perforce source control exists — the Swarm Reviews
  // container must stay out of the Activity Bar entirely.
  test('hides the Swarm Reviews container outside a Perforce workspace', async ({ workbench }) => {
    await expect(workbench.activityBar.item('workbench.view.swarm')).toHaveCount(0)
  })
})
