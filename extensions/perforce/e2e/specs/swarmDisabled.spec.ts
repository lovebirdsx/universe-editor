/*---------------------------------------------------------------------------------------------
 *  Swarm off (`perforce.swarm.enabled: false`) must take the whole Activity Bar
 *  container with it — both the Reviews and the Swarm Changes view — rather than
 *  degrade its contents, and the Swarm focus commands must then be inert instead
 *  of pointing the SideBar at a container that no longer exists.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/swarmApp.js'
import type { Page } from '@playwright/test'

const SWARM_CONTAINER = 'workbench.view.swarm'
const EXPLORER = 'workbench.view.explorer'

const setSwarmEnabled = (page: Page, enabled: boolean): Promise<void> =>
  page.evaluate(
    (value) => window.__E2E__!.updateConfigValue('perforce.swarm.enabled', value),
    enabled,
  )

test.describe('@p1 swarm disabled', () => {
  test('takes the container away and leaves the focus commands inert', async ({
    page,
    workbench,
  }) => {
    // The bootstrap focus restore lands after mount and can clobber a
    // freshly-clicked Activity Bar item (see smoke.activityBar.spec.ts).
    await workbench.waitForBootstrapFocusSettled()

    const item = workbench.activityBar.item(SWARM_CONTAINER)
    // The fixture seeds perforce.swarm.enabled + a Swarm URL, but the container
    // only registers once the perforce extension has activated and published its
    // SCM provider, so a cold boot can outlast the default expect budget.
    await expect(item).toBeVisible({ timeout: 30_000 })

    // Deactivate while it is the active SideBar selection: the selection must
    // move off it rather than stay on a container that no longer exists. Clicking
    // an already-active item closes the SideBar instead, so assert the
    // precondition rather than assume it (memory
    // `hide-view-container-via-deregistration`).
    await expect.poll(() => workbench.sideBar.activeContainerId()).not.toBe(SWARM_CONTAINER)
    await workbench.activityBar.click(SWARM_CONTAINER)
    await expect.poll(() => workbench.sideBar.activeContainerId()).toBe(SWARM_CONTAINER)

    await setSwarmEnabled(page, false)

    await expect(item).toHaveCount(0)
    // Re-seeded to the first remaining SideBar container.
    await expect.poll(() => workbench.sideBar.activeContainerId()).toBe(EXPLORER)

    // Both focus commands stay reachable (command palette) with the switch off and
    // must be clean no-ops. Bringing the SideBar down first is what makes "did
    // nothing" observable: unguarded, either command calls setVisible(SideBar,
    // true) and pops it open on whatever container is active. (Swarm Changes used
    // to also repoint the SideBar at the deregistered container via a bare
    // openViewContainer — a blank SideBar that never recovers.)
    await expect.poll(() => workbench.getContextKey<boolean>('sideBarVisible')).toBe(true)
    await workbench.runCommand('workbench.action.toggleSidebarVisibility')
    await expect.poll(() => workbench.getContextKey<boolean>('sideBarVisible')).toBe(false)
    await workbench.runCommand('workbench.view.swarm.changes.focus')
    await workbench.runCommand('swarm.openReviews')
    await expect.poll(() => workbench.getContextKey<boolean>('sideBarVisible')).toBe(false)

    // Switching it back on restores the entry point.
    await setSwarmEnabled(page, true)
    await expect(item).toBeVisible({ timeout: 30_000 })
  })
})
