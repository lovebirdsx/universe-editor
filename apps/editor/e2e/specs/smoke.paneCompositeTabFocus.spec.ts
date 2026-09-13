/*---------------------------------------------------------------------------------------------
 *  PaneComposite tabs-header click focuses the container's primary view (@p1).
 *
 *  The Panel and the Secondary Side Bar switch containers through an icon tab
 *  strip instead of the ActivityBar, and only the ActivityBar was calling
 *  `focusView`. A tab click therefore opened the container but left DOM focus
 *  wherever it was, so a view that seeds its keyboard cursor on focus showed
 *  nothing selected until the user clicked into the list — the symptom that
 *  "focusing the view selects no row".
 *
 *  Only e2e can hold this: the gap is between a real click on a real tab, the
 *  focusable registry, and the DOM focus that `data-focused` reflects. AI Debug
 *  is the subject rather than Sessions because Sessions has its own
 *  `workbench.action.agent.openView` command that goes through `focusView`
 *  anyway, which would pass with or without the fix.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

const AI_DEBUG_CONTAINER = 'workbench.view.aiDebug'
const AI_DEBUG_VIEW = 'workbench.view.aiDebug.main'

test.describe('@p1 pane composite tab focus', () => {
  test('clicking the AI Debug tab focuses its list', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    // Open the Secondary Side Bar so its tab strip is on screen.
    if ((await workbench.getContextKey<boolean>('secondarySideBarVisible')) !== true) {
      await workbench.runCommand('workbench.action.toggleSecondarySidebarVisibility')
    }
    await expect
      .poll(() => workbench.getContextKey<boolean>('secondarySideBarVisible'), { timeout: 10000 })
      .toBe(true)

    // Park on a different container first, so the click under test is a real
    // switch and not a no-op on an already-active tab.
    const outlineTab = page.getByTestId('view-container-tab-workbench.view.outline')
    await expect(outlineTab).toBeVisible({ timeout: 10000 })
    await outlineTab.click()
    await expect(page.getByRole('listbox', { name: 'Recorded AI requests' })).toHaveCount(0)

    const tab = page.getByTestId(`view-container-tab-${AI_DEBUG_CONTAINER}`)
    await expect(tab).toBeVisible({ timeout: 10000 })
    await tab.click()

    // The payoff: focus reached the list itself, not just the container. (A
    // single-view container renders no ViewPane wrapper, so the list is the
    // thing to wait for.)
    const list = page.getByRole('listbox', { name: 'Recorded AI requests' })
    await expect(list).toBeVisible({ timeout: 5000 })
    await expect(list).toHaveAttribute('data-focused', 'true', { timeout: 5000 })
    await expect.poll(() => workbench.getContextKey<string>('focusedView')).toBe(AI_DEBUG_VIEW)
  })
})
