/*---------------------------------------------------------------------------------------------
 *  Ctrl+P MRU ordering for views (regression).
 *
 *  用户场景:打开 search view(focus 落在它的 input 里),再按 Ctrl+P,search view
 *  必须排在 view 段的最前(MRU 头),而不是按注册顺序被甩到后面。
 *  链路:activityBar.click → focusView → SearchView input 收 focusin →
 *  FocusTracker → FocusStack → RecentTargets._touch → Ctrl+P 空 query 列表。
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/sharedApp.js'

const SEARCH_CONTAINER = 'workbench.view.search'
const SCM_CONTAINER = 'workbench.view.scm'

test.describe('@p1 ctrl+p view MRU', () => {
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForBootstrapFocusSettled()
  })

  test('focusing the search view moves it to the head of the Ctrl+P view list @regression', async ({
    page,
    workbench,
  }) => {
    // Touch SCM first so search is not the most-recent by default: after this,
    // SCM must head the view list, then we focus search and search must jump above.
    await workbench.activityBar.click(SCM_CONTAINER)
    await expect
      .poll(() => workbench.getContextKey<string>('focusedView'))
      .toBe('workbench.view.scm.main')

    await workbench.activityBar.click(SEARCH_CONTAINER)
    await expect
      .poll(() => workbench.getContextKey<string>('focusedView'))
      .toBe('workbench.view.search.results')

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()

    const labels = await workbench.quickInput.dialog.getByRole('option').allTextContents()
    const searchIdx = labels.findIndex((l) => l.startsWith('Search'))
    const scmIdx = labels.findIndex((l) => l.startsWith('Source Control'))
    expect(searchIdx).toBeGreaterThanOrEqual(0)
    expect(scmIdx).toBeGreaterThanOrEqual(0)
    expect(searchIdx).toBeLessThan(scmIdx)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  // The scenario the user reported: an editor is open, the user clicks into the
  // search view, then hits Ctrl+P. Because the search view is the most-recently
  // focused target, it must outrank every editor — i.e. be the first row.
  test('search view focused last outranks open editors in the Ctrl+P list', async ({
    page,
    workbench,
  }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()

    await workbench.activityBar.click(SEARCH_CONTAINER)
    await expect
      .poll(() => workbench.getContextKey<string>('focusedView'))
      .toBe('workbench.view.search.results')

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()

    const labels = await workbench.quickInput.dialog.getByRole('option').allTextContents()
    // Option rows concatenate label + description; the view pick's description is
    // its container label (also "Search"), so the first row reads "SearchSearch".
    expect(labels[0]).toMatch(/^Search/)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })
})
