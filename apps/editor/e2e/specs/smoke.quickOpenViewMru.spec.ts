/*---------------------------------------------------------------------------------------------
 *  Ctrl+P MRU ordering for views (regression).
 *
 *  用户场景:打开 search view(focus 落在它的 input 里),再按 Ctrl+P,search view
 *  必须排在 view 段的最前(MRU 头),而不是按注册顺序被甩到后面。
 *  链路:activityBar.click → focusView → SearchView input 收 focusin →
 *  FocusTracker → FocusStack → RecentTargets._touch → Ctrl+P 空 query 列表。
 *
 *  @regression 用例守护另一个缺陷:最近关闭的编辑器必须留在它关闭前的
 *  recency 位置(排在更早聚焦过的 view 之前),而不是被所有 view 顶到后面。
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../fixtures/sharedApp.js'

const SEARCH_CONTAINER = 'workbench.view.search'
const SCM_CONTAINER = 'workbench.view.scm'

/** Scratch files for the closed-editor case; cleanup rides out open handles. */
async function withTempFiles<T>(
  names: readonly string[],
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-viewmru-'))
  for (const name of names) writeFileSync(join(dir, name), `// ${name}\n`)
  try {
    return await fn(dir.replace(/\\/g, '/'))
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      /* best-effort */
    }
  }
}

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

  // The scenario behind "Ctrl+P 在文件关闭后，顺序不是在靠前，而是会被 views 顶掉":
  // the closed editor keeps its recency slot, but the reader used to skip dead
  // entries, so a file closed after any view had been focused sank below every
  // view in the session. It must stay ahead of the view focused before it.
  test('a just-closed file keeps its recency slot ahead of views used earlier @regression', async ({
    page,
    workbench,
  }) => {
    await withTempFiles(['alpha.ts', 'bravo.ts'], async (dir) => {
      // Touch the search view *before* the files: it then sits below them in the
      // recency list — and is exactly what used to push the closed file down.
      await workbench.activityBar.click(SEARCH_CONTAINER)
      await expect
        .poll(() => workbench.getContextKey<string>('focusedView'))
        .toBe('workbench.view.search.results')

      for (const name of ['alpha.ts', 'bravo.ts']) {
        await page.evaluate(
          (p) => window.__E2E__!.openFileUri(p, { pinned: true }),
          `${dir}/${name}`,
        )
      }
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('bravo.ts')

      await workbench.runCommand('workbench.action.closeActiveEditor')
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('alpha.ts')

      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.quickOpen')
      })
      await workbench.quickInput.waitForVisible()

      const labels = await workbench.quickInput.dialog.getByRole('option').allTextContents()
      const closedIdx = labels.findIndex((l) => /bravo\.ts/.test(l))
      const viewIdx = labels.findIndex((l) => l.startsWith('Search'))
      expect(closedIdx).toBeGreaterThanOrEqual(0)
      expect(viewIdx).toBeGreaterThanOrEqual(0)
      expect(closedIdx).toBeLessThan(viewIdx)

      await page.keyboard.press('Escape')
      await workbench.quickInput.waitForHidden()
    })
  })
})
