/*---------------------------------------------------------------------------------------------
 *  S4 — ActivityBar switches SideBar view containers (P0).
 *
 *  点击 Explorer / Search 项, SideBar 的 data-active-view-container
 *  应跟随变化; 再次点击当前激活项则关闭(VSCode 行为).
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'

const EXPLORER = 'workbench.view.explorer'
const SEARCH = 'workbench.view.search'

test.describe('@p0 activitybar', () => {
  test('switches between Explorer and Search containers', async ({ workbench }) => {
    const { activityBar, sideBar } = workbench

    await expect(activityBar.item(EXPLORER)).toBeVisible()
    await expect(activityBar.item(SEARCH)).toBeVisible()

    await activityBar.click(EXPLORER)
    await expect(sideBar.root).toHaveAttribute('data-active-view-container', EXPLORER)

    await activityBar.click(SEARCH)
    await expect(sideBar.root).toHaveAttribute('data-active-view-container', SEARCH)

    // 再次点击当前激活项 = 关闭
    await activityBar.click(SEARCH)
    await expect(sideBar.root).not.toHaveAttribute('data-active-view-container', SEARCH)
  })
})
