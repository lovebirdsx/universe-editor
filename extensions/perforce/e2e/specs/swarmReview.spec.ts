/*---------------------------------------------------------------------------------------------
 *  Swarm (P4 Code Review) — end-to-end smoke over a fake Swarm REST server.
 *
 *  Exercises the review layer against fixtures/fake-swarm.mjs (no real Helix
 *  Swarm needed): open the Swarm Reviews view → load the dashboard → open a
 *  review's detail tab → vote → change state → add a review-level comment, and
 *  assert the extension issued the matching Swarm requests (recorded by the fake
 *  server). Interactions that are awkward to drive by mouse go through runCommand.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/swarmApp.js'

test.describe('@p1 swarm reviews', () => {
  test('opens a review diff with standard navigation and source-file actions', async ({
    page,
    swarm,
    workbench,
  }) => {
    await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()
    const view = page.locator('[data-testid="swarm-reviews-view"]')
    await expect(view).toBeVisible()
    await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'reviews')

    await view
      .locator('[data-testid="swarm-review-row"]', { hasText: 'Add greeting' })
      .first()
      .click()
    const review = page.locator('[data-testid="swarm-review-editor"]')
    await expect(review.getByText('a.ts')).toBeVisible()
    await review.getByText('a.ts').click()
    await expect(page.locator('[data-testid="swarm-diff-editor"]')).toBeVisible()

    const openFile = page.locator(
      '[data-testid="view-title-action-workbench.action.diffEditor.openFile"]',
    )
    const previous = page.locator(
      '[data-testid="view-title-action-workbench.action.compareEditor.previousChange"]',
    )
    const next = page.locator(
      '[data-testid="view-title-action-workbench.action.compareEditor.nextChange"]',
    )
    await expect(openFile).toBeVisible()
    await expect(previous).toBeVisible()
    await expect(next).toBeVisible()

    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.__E2E__!.getActiveDiffViewState())
          return state?.firstVisibleLine ?? 0
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(1)
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.__E2E__!.getActiveDiffViewState())
        return state?.cursorLine
      })
      .toBe(60)

    await next.click()
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.__E2E__!.getActiveDiffViewState())
        return state?.cursorLine
      })
      .toBe(100)

    await previous.click()
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.__E2E__!.getActiveDiffViewState())
        return state?.cursorLine
      })
      .toBe(60)

    await openFile.click()
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('/src/editor/a.ts')
  })

  test('diffs a file outside the client view (not in the workspace)', async ({ page }) => {
    await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()
    const view = page.locator('[data-testid="swarm-reviews-view"]')
    await expect(view).toBeVisible()

    await view
      .locator('[data-testid="swarm-review-row"]', { hasText: 'Patch shared lib' })
      .first()
      .click()
    const review = page.locator('[data-testid="swarm-review-editor"]')
    // `//other/lib/c.ts` is shelved in the review but lies outside the client
    // view (unmapped by `p4 where`). Its diff sides come from `p4 print` read
    // with no client, so both sides must carry real content — a regression would
    // show a blank diff (the bug this guards).
    await expect(review.getByText('c.ts')).toBeVisible()
    await review.getByText('c.ts').click()
    await expect(page.locator('[data-testid="swarm-diff-editor"]')).toBeVisible()

    await expect
      .poll(async () => {
        const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
        return content?.original
      })
      .toContain('export const c = 1')
    await expect
      .poll(async () => {
        const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
        return content?.modified
      })
      .toContain('export const c = 2')

    // No local mapping → the title-bar "Open File" action is hidden.
    await expect(
      page.locator('[data-testid="view-title-action-workbench.action.diffEditor.openFile"]'),
    ).toHaveCount(0)
  })

  test('diffs a review backed by a submitted change against the pre-edit base', async ({
    page,
  }) => {
    await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()
    const view = page.locator('[data-testid="swarm-reviews-view"]')
    await expect(view).toBeVisible()

    await view
      .locator('[data-testid="swarm-review-row"]', { hasText: 'Bump d constant' })
      .first()
      .click()
    const review = page.locator('[data-testid="swarm-review-editor"]')
    // Change 906 is submitted, so `describe -S` reports d.ts at #6 (the revision
    // containing the edit). The base must resolve to #5, not #6 — otherwise both
    // diff sides show the post-edit content and the diff is blank. Assert the two
    // sides differ (base #5 vs the edit).
    await expect(review.getByText('d.ts')).toBeVisible()
    await review.getByText('d.ts').click()
    await expect(page.locator('[data-testid="swarm-diff-editor"]')).toBeVisible()

    await expect
      .poll(async () => {
        const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
        return content?.original
      })
      .toContain('export const d = 1')
    await expect
      .poll(async () => {
        const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
        return content?.modified
      })
      .toContain('export const d = 2')
  })

  test('loads the dashboard, opens a review, votes, transitions, comments', async ({
    page,
    swarm,
  }) => {
    // Open the Swarm Reviews view container by clicking its Activity Bar item.
    // (A runCommand right after cold boot races ViewsService.reconcileFromStorage,
    // which can clobber the freshly-set active container; the click is the robust
    // user-facing path.)
    await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()

    const view = page.locator('[data-testid="swarm-reviews-view"]')
    await expect(view).toBeVisible()

    // The dashboard derives "needs my action" from the reviews the user authored
    // / participates in (it deliberately does NOT hit the v9 dashboards/action
    // endpoint), so the poll shows up as GET reviews list queries.
    await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'reviews')

    // The seeded review #1001 needs the e2e user's action → a row shows.
    const row = page.locator('[data-testid="swarm-review-row"]').first()
    await expect(row).toBeVisible()
    await expect(row.getByText('Add greeting')).toBeVisible()

    // Open its detail tab.
    await row.click()
    const editor = page.locator('[data-testid="swarm-review-editor"]')
    await expect(editor).toBeVisible()
    await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'reviews/1001')
    await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'reviews/1001/transitions')
    await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'comments')

    // Manual refresh bypasses the short-lived extension-host cache and reloads
    // detail, legal transitions, and review comments as one user action.
    const countRequests = (path: string) => swarm.requests().filter((r) => r.path === path).length
    const detailBeforeRefresh = countRequests('reviews/1001')
    const transitionsBeforeRefresh = countRequests('reviews/1001/transitions')
    const commentsBeforeRefresh = countRequests('comments')
    await editor.getByRole('button', { name: 'Refresh review' }).click()
    await expect.poll(() => countRequests('reviews/1001')).toBeGreaterThan(detailBeforeRefresh)
    await expect
      .poll(() => countRequests('reviews/1001/transitions'))
      .toBeGreaterThan(transitionsBeforeRefresh)
    await expect.poll(() => countRequests('comments')).toBeGreaterThan(commentsBeforeRefresh)

    // Vote up.
    await editor.getByRole('button', { name: 'Vote Up' }).click()
    await swarm.waitForRequest((r) => r.method === 'POST' && r.path === 'reviews/1001/vote')

    // Transition: the fake server offers "Reject" as a legal transition.
    await editor.getByRole('button', { name: 'Reject' }).click()
    await swarm.waitForRequest((r) => r.method === 'PATCH' && r.path === 'reviews/1001/state')

    // The recorded requests carry the expected bodies.
    const reqs = swarm.requests()
    const vote = reqs.find((r) => r.path === 'reviews/1001/vote')
    expect((vote?.body as { vote?: string })?.vote).toBe('up')
    const state = reqs.find((r) => r.path === 'reviews/1001/state')
    expect((state?.body as { state?: string })?.state).toBe('rejected')
  })

  test('shows approvable reviews, exposes row actions, and obliterates with confirmation', async ({
    page,
    swarm,
  }) => {
    await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()
    const view = page.locator('[data-testid="swarm-reviews-view"]')
    await swarm.waitForRequest((request) => request.method === 'GET' && request.path === 'reviews')
    const row = view
      .locator('[data-testid="swarm-review-row"]', { hasText: 'Add greeting' })
      .first()
    await expect(row).toBeVisible()
    await swarm.waitForRequest(
      (request) => request.method === 'GET' && request.path === 'reviews/1001/transitions',
    )
    await expect(row.locator('.lucide-circle-check')).toBeVisible()

    await row.click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: 'Approve', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Open Review in Browser' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Copy Review Name' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Copy Review Link' })).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Open Review', exact: true }).click()

    const editor = page.locator('[data-testid="swarm-review-editor"]')
    const title = editor.getByRole('link', { name: 'Review #1001' })
    await expect(title).toHaveAttribute('href', /\/reviews\/1001$/)
    await editor.getByRole('button', { name: 'Obliterate Review' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('cannot be undone')
    await dialog.getByRole('button', { name: 'Obliterate Review' }).click()

    await swarm.waitForRequest(
      (request) => request.method === 'POST' && request.path === 'reviews/1001/obliterate',
    )
    await expect(editor).toHaveCount(0)
  })

  test('switching reviews refreshes the whole detail, not just comments', async ({
    page,
    swarm,
  }) => {
    await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()
    const view = page.locator('[data-testid="swarm-reviews-view"]')
    await expect(view).toBeVisible()
    await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'reviews')

    // Open review #1001 (author alice) and confirm its header rendered.
    await view
      .locator('[data-testid="swarm-review-row"]', { hasText: 'Add greeting' })
      .first()
      .click()
    const editor = page.locator('[data-testid="swarm-review-editor"]')
    await expect(editor).toBeVisible()
    await expect(editor.getByText('Review #1001')).toBeVisible()
    await expect(editor.getByText('alice')).toBeVisible()

    // Switch to review #1002 (author bob). The header, author and description must
    // all reflect #1002 — a stale-state bug would leave everything but the comments
    // panel showing #1001.
    await view
      .locator('[data-testid="swarm-review-row"]', { hasText: 'Fix farewell' })
      .first()
      .click()
    const editor1002 = page.locator('[data-testid="swarm-review-editor"]')
    await expect(editor1002.getByText('Review #1002')).toBeVisible()
    await expect(editor1002.getByText('bob')).toBeVisible()
    await expect(editor1002.getByText('Fix farewell')).toBeVisible()
    await expect(editor1002.getByText('Review #1001')).toHaveCount(0)
  })

  test('restores an open review and switches its changed files between list and tree', async ({
    page,
    swarm,
    workbench,
  }) => {
    await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()
    const view = page.locator('[data-testid="swarm-reviews-view"]')
    await expect(view).toBeVisible()
    await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'reviews')

    await view
      .locator('[data-testid="swarm-review-row"]', { hasText: 'Add greeting' })
      .first()
      .click()
    let editor = page.locator('[data-testid="swarm-review-editor"]')
    await expect(editor.getByText('Review #1001')).toBeVisible()
    await expect(editor.getByText('a.ts')).toBeVisible()
    await expect(editor.getByText('depot/src/editor')).toBeVisible()

    await editor.getByRole('button', { name: 'View as Tree' }).click()
    await expect(editor.locator('[data-testid="swarm-review-file-folder"]')).toHaveCount(3)
    await editor.getByText('editor', { exact: true }).click()
    await expect(editor.getByText('a.ts')).toHaveCount(0)
    await expect(editor.getByText('b.ts')).toBeVisible()

    await editor.getByRole('button', { name: 'View as List' }).click()
    await expect(editor.locator('[data-testid="swarm-review-file-folder"]')).toHaveCount(0)
    await expect(editor.getByText('depot/src/runtime')).toBeVisible()

    await editor.getByRole('button', { name: 'View as Tree' }).click()
    await expect(editor.locator('[data-testid="swarm-review-file-folder"]')).toHaveCount(3)
    const requestsBeforeRestart = swarm.requests().filter((r) => r.path === 'reviews/1001').length
    await workbench.waitForRestartRestore()

    editor = page.locator('[data-testid="swarm-review-editor"]')
    await expect(editor.getByText('Review #1001')).toBeVisible()
    await expect(editor.getByText('Review #1001 is unavailable.')).toHaveCount(0)
    await expect(editor.locator('[data-testid="swarm-review-file-folder"]')).toHaveCount(3)
    await expect
      .poll(() => swarm.requests().filter((r) => r.path === 'reviews/1001').length)
      .toBeGreaterThan(requestsBeforeRestart)
  })

  test('pushes the keyword filter down to the server query', async ({ page, swarm }) => {
    await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()
    const view = page.locator('[data-testid="swarm-reviews-view"]')
    await expect(view).toBeVisible()
    await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'reviews')

    // Both seeded reviews show up unfiltered.
    await expect(
      view.locator('[data-testid="swarm-review-row"]', { hasText: 'Add greeting' }).first(),
    ).toBeVisible()
    await expect(
      view.locator('[data-testid="swarm-review-row"]', { hasText: 'Fix farewell' }).first(),
    ).toBeVisible()

    // Typing a keyword pushes it down as a `keywords` query param (not a
    // fetch-everything-then-filter-in-memory pass), and the list narrows to the
    // single matching review without a manual refresh.
    await view.getByPlaceholder('Filter reviews…').fill('greeting')
    await swarm.waitForRequest(
      (r) => r.method === 'GET' && r.path === 'reviews' && r.query.includes('keywords=greeting'),
    )
    await expect(
      view.locator('[data-testid="swarm-review-row"]', { hasText: 'Add greeting' }).first(),
    ).toBeVisible()
    await expect(
      view.locator('[data-testid="swarm-review-row"]', { hasText: 'Fix farewell' }),
    ).toHaveCount(0)
  })

  test('manual refresh in the view title bar re-fetches the dashboard', async ({ page, swarm }) => {
    await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()
    const view = page.locator('[data-testid="swarm-reviews-view"]')
    await expect(view).toBeVisible()
    await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'reviews')

    // Rows show the description, not the leading #id.
    const row = view
      .locator('[data-testid="swarm-review-row"]', { hasText: 'Add greeting' })
      .first()
    await expect(row).toBeVisible()
    await expect(view.getByText('#1001')).toHaveCount(0)

    const listRequestsBefore = swarm.requests().filter((r) => r.path === 'reviews').length
    await page.locator('[data-testid="view-title-action-swarm.refreshReviews"]').click()
    await expect
      .poll(() => swarm.requests().filter((r) => r.path === 'reviews').length)
      .toBeGreaterThan(listRequestsBefore)
  })
})
