/*---------------------------------------------------------------------------------------------
 *  Swarm review "Apply to Local" — end-to-end over the fake p4 CLI + fake Swarm.
 *
 *  The button unshelves the selected version's snapshot (`p4 unshelve -s <change>
 *  -f <files>`), so assertions go straight to the filesystem: the baseline files
 *  on disk must be replaced by the shelved content and land in the default
 *  changelist. A fault-injection variant has the fake p4 refuse one file, which
 *  must surface as a warning notification listing it as skipped.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../fixtures/swarmApp.js'
import type { Page } from '@playwright/test'

async function openReview(page: Page, swarm: { waitForRequest: Function }, hasText: string) {
  await page.locator('[data-testid="activitybar-item-workbench.view.swarm"]').click()
  const view = page.locator('[data-testid="swarm-reviews-view"]')
  await expect(view).toBeVisible()
  await swarm.waitForRequest(
    (r: { method: string; path: string }) => r.method === 'GET' && r.path === 'reviews',
  )
  await view.locator('[data-testid="swarm-review-row"]', { hasText }).first().click()
  const review = page.locator('[data-testid="swarm-review-editor"]')
  await expect(review).toBeVisible()
  return review
}

test.describe('@p1 swarm apply to local', () => {
  test('replaces local files with the review version into the default changelist', async ({
    page,
    swarm,
    swarmBackend,
  }) => {
    test.setTimeout(60_000)
    const aTs = join(swarmBackend.clientRoot, 'src', 'editor', 'a.ts')
    const bTs = join(swarmBackend.clientRoot, 'src', 'runtime', 'b.ts')
    const baselineA = readFileSync(aTs, 'utf8')

    const review = await openReview(page, swarm, 'Add greeting')
    await expect(review.getByText('a.ts')).toBeVisible()
    await review.getByTestId('swarm-review-apply').click()

    // The confirm dialog explains the replacing semantics and offers the
    // outside-workspace toggle (nothing outside here, so it stays off).
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('replaces the local content')
    await dialog.getByRole('button', { name: 'Apply to Local' }).click()

    // Both files were replaced on disk with the shelved snapshot content, and
    // the success toast reports the count.
    await expect(page.locator('[data-testid="notification-toast-item"]')).toContainText(
      'Applied 2 file(s)',
    )
    await expect
      .poll(() => readFileSync(aTs, 'utf8'), { timeout: 10_000 })
      .toContain('export const line60 = 60 + 1')
    expect(readFileSync(aTs, 'utf8')).not.toBe(baselineA)
    expect(readFileSync(bTs, 'utf8')).toBe('export const b = 2\n')

    // Both landed in the default changelist, i.e. `p4 opened` reports them.
    const state = JSON.parse(readFileSync(swarmBackend.stateFile, 'utf8')) as {
      opened: Record<string, { action: string; change: string }>
    }
    expect(state.opened['//depot/src/editor/a.ts']?.change).toBe('default')
    expect(state.opened['//depot/src/runtime/b.ts']?.change).toBe('default')
  })

  test('reports files p4 refuses as skipped and applies the rest', async ({
    page,
    swarm,
    swarmBackend,
  }) => {
    test.setTimeout(60_000)
    // Fault injection: p4 refuses to unshelve b.ts (as if it were already
    // open); a.ts must still be applied and b.ts reported as skipped.
    const state = JSON.parse(readFileSync(swarmBackend.stateFile, 'utf8')) as Record<
      string,
      unknown
    >
    state['unshelveRefuse'] = ['//depot/src/runtime/b.ts']
    writeFileSync(swarmBackend.stateFile, JSON.stringify(state), 'utf8')

    const review = await openReview(page, swarm, 'Add greeting')
    await expect(review.getByText('a.ts')).toBeVisible()
    await review.getByTestId('swarm-review-apply').click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Apply to Local' }).click()

    await expect(page.locator('[data-testid="notification-toast-item"]').first()).toContainText(
      'Applied 1 file(s); 1 skipped',
    )
    await expect(page.locator('[data-testid="notification-toast-item"]').first()).toContainText(
      '//depot/src/runtime/b.ts',
    )
    // a.ts was replaced; b.ts kept its baseline content.
    await expect
      .poll(() => readFileSync(join(swarmBackend.clientRoot, 'src', 'editor', 'a.ts'), 'utf8'), {
        timeout: 10_000,
      })
      .toContain('export const line60 = 60 + 1')
    expect(readFileSync(join(swarmBackend.clientRoot, 'src', 'runtime', 'b.ts'), 'utf8')).toBe(
      'export const b = 1\n',
    )
  })
})
