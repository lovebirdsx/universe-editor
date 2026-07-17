/*---------------------------------------------------------------------------------------------
 *  Search results ordering-stability regression (@p1).
 *
 *  ripgrep streams matches in a nondeterministic thread-completion order, so the
 *  same query used to yield a different file order run to run — the search tree
 *  reshuffled when re-mounted / re-searched. The main-process search now sorts
 *  results on a stable path key. This test runs the same query twice (clear +
 *  re-search) over a broad tree of small files and asserts identical order.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

const SEARCH = 'workbench.view.search'
const NEEDLE = 'order-needle'

function writeWorkspace(): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-searchorder-'))
  // Many small files across several directories: small files finish near-
  // simultaneously on different ripgrep threads, maximizing order nondeterminism.
  for (let d = 0; d < 8; d++) {
    mkdirSync(join(dir, `dir${d}`), { recursive: true })
    for (let i = 0; i < 12; i++) {
      writeFileSync(
        join(dir, `dir${d}`, `f${String(i).padStart(2, '0')}.txt`),
        `${NEEDLE}\n`,
        'utf8',
      )
    }
  }
  return { dir }
}

async function fileOrder(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="search-view"] [data-row-key]'),
    )
    return rows
      .map((r) => r.getAttribute('data-row-key') ?? '')
      .filter((k) => k.startsWith('file:'))
  })
}

test.describe('@p1 search order', () => {
  test('two consecutive searches produce the same file order @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const { dir } = writeWorkspace()
    await workbench.openWorkspace(dir)
    await workbench.activityBar.click(SEARCH)

    const searchView = page.getByTestId('search-view')
    await expect(searchView).toBeVisible()
    const input = searchView.getByRole('textbox', { name: 'Search', exact: true })

    const runOnce = async (): Promise<string[]> => {
      await input.fill('')
      await input.fill(NEEDLE)
      await expect(searchView.getByTestId('search-summary')).toContainText('匹配', {
        timeout: 20000,
      })
      await page.waitForTimeout(800)
      return fileOrder(page)
    }

    const first = await runOnce()
    expect(first.length).toBeGreaterThan(50)

    // Run the same query several more times; every run must match the first.
    for (let i = 0; i < 3; i++) {
      const next = await runOnce()
      expect(next, `run ${i + 1}`).toEqual(first)
    }
  })
})
