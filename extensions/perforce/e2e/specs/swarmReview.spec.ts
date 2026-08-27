/*---------------------------------------------------------------------------------------------
 *  Swarm (P4 Code Review) — end-to-end smoke over a fake Swarm REST server.
 *
 *  Exercises the review layer against fixtures/fake-swarm.mjs (no real Helix
 *  Swarm needed). Scenarios that share a cold launch are merged into journeys
 *  (each cold start costs ~10s and this suite launches one Electron per TEST):
 *  read-only diff flows ride one app, list interactions another, and the
 *  mutating flow (vote → transition → obliterate) runs last-in-line inside its
 *  own journey so state changes never leak into unrelated assertions. Each
 *  original scenario stays a test.step so failures still name it.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/swarmApp.js'
import type { Page } from '@playwright/test'

async function openSwarmView(page: Page, swarm: { waitForRequest: Function }) {
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
  await swarm.waitForRequest(
    (r: { method: string; path: string }) => r.method === 'GET' && r.path === 'reviews',
  )
  return view
}

test.describe('@p1 swarm reviews', () => {
  test('opens review diffs: navigation and source actions, out-of-view file, submitted-change base', async ({
    page,
    swarm,
    workbench,
  }) => {
    test.setTimeout(90_000)
    const view = await openSwarmView(page, swarm)
    const review = page.locator('[data-testid="swarm-review-editor"]')
    const diff = page.locator('[data-testid="swarm-diff-editor"]')
    const openFile = page.locator(
      '[data-testid="view-title-action-workbench.action.diffEditor.openFile"]',
    )

    await test.step('standard navigation and source-file actions', async () => {
      await view
        .locator('[data-testid="swarm-review-row"]', { hasText: 'Add greeting' })
        .first()
        .click()
      await expect(review.getByText('a.ts')).toBeVisible()
      await review.getByText('a.ts').click()
      await expect(diff).toBeVisible()

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

    await test.step('diffs a file outside the client view (not in the workspace)', async () => {
      await view
        .locator('[data-testid="swarm-review-row"]', { hasText: 'Patch shared lib' })
        .first()
        .click()
      // `//other/lib/c.ts` is shelved in the review but lies outside the client
      // view (unmapped by `p4 where`). Its diff sides come from `p4 print` read
      // with no client, so both sides must carry real content — a regression would
      // show a blank diff (the bug this guards).
      // First click on this review = cold detail load (describe + transitions +
      // comments, each a fake-p4 spawn over the multi-MB state) — outlives the
      // default expect timeout under load.
      await expect(review.getByText('c.ts')).toBeVisible({ timeout: 15_000 })
      await review.getByText('c.ts').click()
      await expect(diff).toBeVisible()

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
      await expect(openFile).toHaveCount(0)
    })

    await test.step('diffs a file whose depot path contains non-ASCII (Chinese) segments', async () => {
      await view
        .locator('[data-testid="swarm-review-row"]', { hasText: 'Patch shared lib' })
        .first()
        .click()
      // `//depot/资源库/资源表.ts` is shelved in the same review. Its
      // `p4 print` args are non-ASCII and only reach the server intact via the
      // `-x` argfile — a regression shows a blank diff on both sides (the bug
      // this guards).
      await expect(review.getByText('资源表.ts')).toBeVisible()
      await review.getByText('资源表.ts').click()
      await expect(diff).toBeVisible()

      await expect
        .poll(async () => {
          const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
          return content?.original
        })
        .toContain('资源表基线')
      await expect
        .poll(async () => {
          const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
          return content?.modified
        })
        .toContain('资源表改动')
    })

    await test.step('routes an oversized Chinese-path csv to the Monaco text diff, not the webview', async () => {
      await view
        .locator('[data-testid="swarm-review-row"]', { hasText: 'Patch shared lib' })
        .first()
        .click()
      // `//depot/资源库/数据集.csv` decodes past the 1MB spreadsheet-diff cap:
      // the Excel webview's whole-table LCS would OOM the extension host, so the
      // review must fall back to the plain text diff — fetched via `p4 print`
      // through the `-x` argfile (the path is non-ASCII).
      await expect(review.getByText('数据集.csv')).toBeVisible()
      await review.getByText('数据集.csv').click()
      // Two 1.1MB `p4 print` round-trips (bytes probe, both sides; the text diff
      // reuses the probed bytes) precede the editor mount.
      // Poll for ANY terminal editor kind, then assert which. A mis-route opens
      // the excel viewType via a custom-editor host — which has no provider in
      // this perforce-only suite, so neither the diff nor the webview-frame
      // testid ever appears and a bare two-way poll dies as a silent 25s
      // timeout (the CI shape of the fake-p4 stdout-truncation bug).
      const webviewFrame = page.locator('[data-testid="webview-frame"]')
      const customEditor = page.locator('[data-testid="custom-editor"]')
      await expect
        .poll(
          async () =>
            (await diff.count()) + (await webviewFrame.count()) + (await customEditor.count()),
          { timeout: 25_000 },
        )
        .toBeGreaterThan(0)
      await expect(diff).toBeVisible()
      await expect(webviewFrame).toHaveCount(0)
      await expect(customEditor).toHaveCount(0)

      await expect
        .poll(
          async () => {
            const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
            return content?.original
          },
          { timeout: 15_000 },
        )
        .toContain('数据集基线')
      await expect
        .poll(async () => {
          const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
          return content?.modified
        })
        .toContain('数据集改动')
    })

    await test.step('diffs a submitted-change review against the pre-edit base', async () => {
      await view
        .locator('[data-testid="swarm-review-row"]', { hasText: 'Bump d constant' })
        .first()
        .click()
      // Change 906 is submitted, so `describe -S` reports d.ts at #6 (the revision
      // containing the edit). The base must resolve to #5, not #6 — otherwise both
      // diff sides show the post-edit content and the diff is blank. Assert the two
      // sides differ (base #5 vs the edit).
      await expect(review.getByText('d.ts')).toBeVisible()
      await review.getByText('d.ts').click()
      await expect(diff).toBeVisible()

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
  })

  test('dashboard list: manual refresh, server-side keyword filter, switching reviews', async ({
    page,
    swarm,
  }) => {
    test.setTimeout(90_000)
    const view = await openSwarmView(page, swarm)

    await test.step('manual refresh in the view title bar re-fetches the dashboard', async () => {
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

    await test.step('pushes the keyword filter down to the server query', async () => {
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

      // Clear the filter so the full list is back for the next step.
      await view.getByPlaceholder('Filter reviews…').fill('')
      await expect(
        view.locator('[data-testid="swarm-review-row"]', { hasText: 'Fix farewell' }).first(),
      ).toBeVisible({ timeout: 15_000 })
    })

    await test.step('switching reviews refreshes the whole detail, not just comments', async () => {
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
      await expect(editor.getByText('Review #1002')).toBeVisible()
      await expect(editor.getByText('bob')).toBeVisible()
      await expect(editor.getByText('Fix farewell')).toBeVisible()
      await expect(editor.getByText('Review #1001')).toHaveCount(0)
    })
  })

  test('approvable row actions, then votes, transitions, comments, and obliterates with confirmation', async ({
    page,
    swarm,
  }) => {
    test.setTimeout(90_000)
    const view = await openSwarmView(page, swarm)
    const editor = page.locator('[data-testid="swarm-review-editor"]')

    await test.step('shows the approvable marker and row context actions', async () => {
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

      const title = editor.getByRole('link', { name: 'Review #1001' })
      await expect(title).toHaveAttribute('href', /\/reviews\/1001$/)
      await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'reviews/1001')
      await swarm.waitForRequest((r) => r.method === 'GET' && r.path === 'comments')
    })

    await test.step('manual detail refresh reloads detail, transitions and comments', async () => {
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
    })

    await test.step('votes up and transitions the review state', async () => {
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

    await test.step('obliterates the review after an explicit confirmation', async () => {
      await editor.getByRole('button', { name: 'Obliterate Review' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toContainText('cannot be undone')
      await dialog.getByRole('button', { name: 'Obliterate Review' }).click()

      await swarm.waitForRequest(
        (request) => request.method === 'POST' && request.path === 'reviews/1001/obliterate',
      )
      await expect(editor).toHaveCount(0)
    })
  })

  test('multi-version pending review: defaults to the newest version and the selector actually switches', async ({
    page,
    swarm,
  }) => {
    test.setTimeout(90_000)
    const view = await openSwarmView(page, swarm)
    const editor = page.locator('[data-testid="swarm-review-editor"]')
    const diff = page.locator('[data-testid="swarm-diff-editor"]')

    await test.step('opens on the newest pending version, not the first-recorded one', async () => {
      await view
        .locator('[data-testid="swarm-review-row"]', { hasText: 'Multi-version shelf' })
        .first()
        .click()
      await expect(editor.getByText('Review #1006')).toBeVisible()

      // All three pending versions report rev 1 (Swarm only bumps the rev on
      // approve), so the selector distinguishes them by backing change and must
      // default to the NEWEST shelf (912). A version-number-keyed lookup silently
      // resolves to the first entry (910) instead.
      const versionSelect = editor.locator('select').nth(1)
      await expect(versionSelect.locator('option:checked')).toHaveText('v1 (912)')

      await expect(editor.getByText('e.ts')).toBeVisible()
      await editor.getByText('e.ts').click()
      await expect(diff).toBeVisible()
      await expect
        .poll(async () => {
          const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
          return content?.modified
        })
        .toContain('export const e = 3')
    })

    await test.step('switching the version selector re-resolves the file list and diff', async () => {
      // The diff opened in step 1 deactivated the review tab (only the active
      // editor renders) — switch back to it before touching the selector.
      await page
        .locator('[data-testid="editor-group-tabbar"]')
        .getByText('Review #1006')
        .first()
        .click()
      const versionSelect = editor.locator('select').nth(1)
      await versionSelect.selectOption({ label: 'v1 (911)' })
      await expect(versionSelect.locator('option:checked')).toHaveText('v1 (911)')

      await editor.getByText('e.ts').click()
      await expect
        .poll(async () => {
          const content = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
          return content?.modified
        })
        .toContain('export const e = 2')
    })
  })

  test('restores an open review and switches its changed files between list and tree', async ({
    page,
    swarm,
    workbench,
  }) => {
    const view = await openSwarmView(page, swarm)

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
})
