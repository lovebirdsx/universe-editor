/*---------------------------------------------------------------------------------------------
 *  Global Vim mode (@p0).
 *
 *  Guards the workbench-wide contract: bare Vim keys drive the focused list
 *  surface (counts, gg/G), the leader reaches global commands from a list, and
 *  text inputs / Quick Input keep their own letters. Turning `vim.enabled` off
 *  restores plain typing.
 *
 *  The Explorer has no filter box, so the editable-pass-through step uses the
 *  sidebar Search input (a real text field beside a Vim list surface).
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'
import {
  focusExplorerTree,
  selectedTreeRow,
  setVimEnabled,
  statusIcon,
} from '../pages/vimHelpers.js'

const BODY = 'alpha beta\ngamma delta\n'

function seedTreeFiles(dir: string): void {
  for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
    writeFileSync(join(dir, name), name, 'utf8')
  }
}

test.describe('@p0 vim global', () => {
  test('bare keys drive the Explorer tree with counts and gg/G', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-global-')
    seedTreeFiles(dir)
    await workbench.openWorkspace(dir)
    await focusExplorerTree(page)

    await page.keyboard.press('j')
    await expect.poll(() => selectedTreeRow(page).textContent()).toContain('beta.txt')
    await page.keyboard.press('j')
    await expect.poll(() => selectedTreeRow(page).textContent()).toContain('gamma.txt')
    await page.keyboard.press('k')
    await expect.poll(() => selectedTreeRow(page).textContent()).toContain('beta.txt')

    await page.keyboard.press('G')
    await expect.poll(() => selectedTreeRow(page).textContent()).toContain('gamma.txt')
    await page.keyboard.press('g')
    await page.keyboard.press('g')
    await expect.poll(() => selectedTreeRow(page).textContent()).toContain(basename(dir))

    // Visible order: workspace root, alpha, beta, gamma.
    await page.keyboard.press('3')
    await page.keyboard.press('j')
    await expect.poll(() => selectedTreeRow(page).textContent()).toContain('gamma.txt')

    // An unmapped printable key is claimed by Vim: no selection change and no
    // leak into Quick Open / find.
    await page.keyboard.press('e')
    await expect.poll(() => selectedTreeRow(page).textContent()).toContain('gamma.txt')
    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(false)
    await expect.poll(() => workbench.getContextKey<boolean>('findWidgetVisible')).toBe(false)
    await expect(page.locator('[role="tree"][data-focused="true"]').first()).toBeVisible()
  })

  test('<leader>p opens the command palette and the quick input keeps typing', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-leader-p-')
    seedTreeFiles(dir)
    await workbench.openWorkspace(dir)
    await focusExplorerTree(page)

    await page.keyboard.press('Space')
    await page.keyboard.press('p')
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toBeFocused()

    await page.keyboard.type('vim')
    await expect(workbench.quickInput.input).toHaveValue('>vim')
    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(true)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('<leader>e focuses the Explorer from another Vim surface', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-leader-e-')
    seedTreeFiles(dir)
    const filePath = join(dir, 'alpha.txt')
    await workbench.openWorkspace(dir)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)

    // Search results live in the same SideBar part as the Explorer but form a
    // different list surface, so `<leader>e` must switch the container rather
    // than toggle the focused part closed.
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.findInFiles'))
    const searchView = page.getByTestId('search-view')
    const input = searchView.getByRole('textbox', { name: 'Search', exact: true })
    await input.fill('alpha')
    const resultRow = searchView.locator('[role="treeitem"]').first()
    await expect(resultRow).toBeVisible({ timeout: 10_000 })
    // Tab moves the keyboard from the query input into the results tree.
    await input.press('Tab')
    await expect
      .poll(() => workbench.getContextKey<string>('focusedView'))
      .toBe('workbench.view.search.results')

    await page.keyboard.press('Space')
    await page.keyboard.press('e')
    await expect
      .poll(() => workbench.getContextKey<string>('focusedView'))
      .toBe('workbench.view.explorer.tree')
  })

  test('sidebar search input keeps its letters while Vim is on', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-input-')
    seedTreeFiles(dir)
    await workbench.openWorkspace(dir)
    const alphaPath = join(dir, 'alpha.txt')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), alphaPath)
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)

    // Editor focus keeps the command out of its "toggle closed" branch.
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.findInFiles'))
    const searchView = page.getByTestId('search-view')
    const input = searchView.getByRole('textbox', { name: 'Search', exact: true })
    await expect(input).toBeVisible()
    await input.click()
    await page.keyboard.type('alpha')
    await expect(input).toHaveValue('alpha')

    // Vim did not activate a list surface for the editable target.
    await expect.poll(() => workbench.getContextKey<string>('vimSurface')).not.toBe('list')
  })

  test('editor Normal mode leader focuses the Explorer', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-editor-leader-')
    seedTreeFiles(dir)
    const filePath = join(dir, 'alpha.txt')
    writeFileSync(filePath, BODY, 'utf8')
    await workbench.openWorkspace(dir)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
    await expect.poll(() => workbench.getContextKey<string>('vimSurface')).toBe('editor')
    await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('normal')

    // Editors bypass the shared sequence engine, so the leader must be the
    // explicit exception: <leader>e closes the loop from the text surface too.
    await page.keyboard.press('Space')
    await page.keyboard.press('e')
    await expect
      .poll(() => workbench.getContextKey<string>('focusedView'))
      .toBe('workbench.view.explorer.tree')
  })

  test('Esc, <leader>w l and Ctrl+O / Ctrl+I share one jump list with the Explorer', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-way-back-')
    seedTreeFiles(dir)
    writeFileSync(
      join(dir, 'beta.txt'),
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'),
      'utf8',
    )
    // A folder row: clicking a file would open it and rewrite the history under test.
    mkdirSync(join(dir, 'folder'))
    await workbench.openWorkspace(dir)
    for (const name of ['alpha.txt', 'beta.txt']) {
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), join(dir, name))
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()))
        .toContain(name)
    }
    await expect.poll(() => workbench.getContextKey<boolean>('canGoBack')).toBe(true)
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(20, 1))
    const activeUri = () => page.evaluate(() => window.__E2E__!.getActiveEditorUri())
    const cursorLine = () =>
      page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber)
    const editorFocused = () => workbench.getContextKey<boolean>('editorTextFocus')
    const focusedView = () => workbench.getContextKey<string>('focusedView')

    await test.step('idle Esc in the Explorer returns to the editor', async () => {
      await focusExplorerTree(page, 'folder')
      await page.keyboard.press('Escape')
      await expect.poll(editorFocused).toBe(true)
      await expect.poll(activeUri).toContain('beta.txt')
    })

    await test.step('<leader>w l moves right from the side bar into the editor', async () => {
      await focusExplorerTree(page, 'folder')
      await page.keyboard.press('Space')
      await page.keyboard.press('w')
      await page.keyboard.press('l')
      await expect.poll(editorFocused).toBe(true)
    })

    await test.step('Ctrl+O from the Explorer lands where the editor lost focus', async () => {
      await focusExplorerTree(page, 'folder')
      await page.keyboard.press('Control+o')
      await expect.poll(activeUri).toContain('beta.txt')
      await expect.poll(cursorLine).toBe(20)
      await expect.poll(editorFocused).toBe(true)
      await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(false)
    })

    await test.step('Ctrl+I in the editor returns to the Explorer', async () => {
      await page.keyboard.press('Control+i')
      await expect.poll(focusedView).toBe('workbench.view.explorer.tree')
    })

    await test.step('Ctrl+O walks back past the editor to the older file', async () => {
      await page.keyboard.press('Control+o')
      await expect.poll(activeUri).toContain('beta.txt')
      await expect.poll(cursorLine).toBe(20)
      await expect.poll(editorFocused).toBe(true)
      await page.keyboard.press('Control+o')
      await expect.poll(activeUri).toContain('alpha.txt')
    })
  })

  test('editor Normal mode <leader>O opens the workbench symbol picker', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-symbols-')
    const filePath = join(dir, 'alpha.txt')
    writeFileSync(filePath, BODY, 'utf8')
    await workbench.openWorkspace(dir)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
    await expect.poll(() => workbench.getContextKey<string>('vimSurface')).toBe('editor')
    await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('normal')

    // The workbench picker opens even without a document symbol provider
    // (Monaco's quickOutline would silently no-op on a .txt file).
    await page.keyboard.press('Space')
    await page.keyboard.press('O')
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toHaveValue('@')
    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(true)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('vim.enabled=false restores plain typing', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-off-')
    seedTreeFiles(dir)
    const filePath = join(dir, 'plain.txt')
    writeFileSync(filePath, BODY, 'utf8')
    await workbench.openWorkspace(dir)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
    await setVimEnabled(page, false)
    await expect.poll(() => statusIcon(page)).toBeUndefined()

    await expect
      .poll(() => page.evaluate((body) => window.__E2E__!.setActiveEditorText(body), BODY))
      .toBe(true)
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
    await page.keyboard.press('j')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()))
      .toBe(`j${BODY}`)
  })
})
