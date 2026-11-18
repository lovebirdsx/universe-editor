/*---------------------------------------------------------------------------------------------
 *  Vim mode (@p1).
 *
 *  Guards the Normal/Insert mode contract behind `editor.vimMode.enabled`:
 *  bare-key navigation, operators, the Insert hand-off, the status-bar mode
 *  indicator, Ctrl+F paging (which must page the editor instead of opening the
 *  find widget), list navigation on the Explorer tree, and — most importantly —
 *  that turning the setting off restores plain typing.
 *
 *  The setting is USER scope and the shared fixture rewrites settings.json
 *  between tests, so each test opts in on its own.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

/** 5 lines including the trailing empty one; word boundaries are predictable. */
const BODY = 'alpha beta\ngamma delta\nepsilon zeta\neta theta\n'

/** Taller than any editor viewport, so a page-scroll has somewhere to go. */
const TALL_BODY = `${Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')}\n`

/**
 * A workspace change opens a ~1.5s window in which the workbench restores focus
 * to the active editor (WorkspaceFocusRestoreContribution). Interactions that
 * must land in the Explorer have to wait it out first — same constant as
 * smoke.explorerSelection.
 */
const RESTORE_WINDOW_MS = 1700

interface WorkbenchLike {
  openWorkspace(path: string): Promise<void>
  getContextKey<T = unknown>(key: string): Promise<T>
}

const text = (page: Page) => page.evaluate(() => window.__E2E__!.getActiveEditorText())
const cursor = (page: Page) => page.evaluate(() => window.__E2E__!.getActiveEditorCursor())
const firstVisibleLine = (page: Page) =>
  page.evaluate(() => window.__E2E__!.getActiveEditorFirstVisibleLine())

async function setText(page: Page, body: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((t) => window.__E2E__!.setActiveEditorText(t), body))
    .toBe(true)
}

async function setVimModeEnabled(page: Page, enabled: boolean): Promise<void> {
  // Cold start hydrates user settings after the first frame; a write before
  // that point is lost without a retry (the configuration subscription is
  // registered at the end of initialize()).
  await page.evaluate(() => window.__E2E__!.whenUserSettingsInitialized())
  await page.evaluate(
    (value) =>
      window.__E2E__!.runCommand('_workbench.updateConfiguration', 'editor.vimMode.enabled', value),
    enabled,
  )
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.__E2E__!.runCommand('_workbench.getConfiguration', key),
        'editor.vimMode.enabled',
      ),
    )
    .toBe(enabled)
}

async function statusIcon(page: Page): Promise<string | undefined> {
  const entries = await page.evaluate(() => window.__E2E__!.getStatusBarEntries())
  return entries.find((entry) => entry.entryId === 'vim-mode')?.icon
}

/** Open one temp file through a real workspace so Monaco's text focus lands. */
async function openEditor(
  page: Page,
  workbench: WorkbenchLike,
  body: string = BODY,
): Promise<void> {
  const dir = mkTempDir('universe-editor-e2e-vim-')
  const filePath = join(dir, 'vim.txt')
  writeFileSync(filePath, body, 'utf8')
  await workbench.openWorkspace(dir)
  await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')))
    .toBe(true)
}

test.describe('@p1 vim mode', () => {
  test('Normal mode navigates, edits and pages the buffer', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openEditor(page, workbench)
    await setVimModeEnabled(page, true)

    await expect.poll(() => statusIcon(page)).toBe('vim-normal')

    await test.step('hjkl move by character and line', async () => {
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('j')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await page.keyboard.press('k')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })
      await page.keyboard.press('l')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 2 })
      await page.keyboard.press('h')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })
    })

    await test.step('arrow/Home/End/Enter navigate instead of being swallowed', async () => {
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('ArrowDown')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await page.keyboard.press('ArrowUp')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 2 })
      await page.keyboard.press('ArrowLeft')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })
      await page.keyboard.press('End')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 10 })
      await page.keyboard.press('Home')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })
      await page.keyboard.press('Enter')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
    })

    await test.step('0/$ and w/b jump to line and word boundaries', async () => {
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('$')
      // Normal mode stops on the last character, not the insert position.
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 10 })
      await page.keyboard.press('0')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })
      await page.keyboard.press('w')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 7 })
      await page.keyboard.press('b')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })
    })

    await test.step('gg/G jump to the first and last line', async () => {
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 3))
      await page.keyboard.press('g')
      await page.keyboard.press('g')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })
      await page.keyboard.press('G')
      // The trailing newline makes line 5 the empty last line.
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 5, column: 1 })
    })

    await test.step('i enters Insert, typing edits, Escape returns to Normal', async () => {
      await setText(page, BODY)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('i')
      await expect.poll(() => statusIcon(page)).toBe('vim-insert')
      await page.keyboard.type('X')
      await expect.poll(() => text(page)).toBe(`X${BODY}`)
      await page.keyboard.press('Escape')
      await expect.poll(() => statusIcon(page)).toBe('vim-normal')
    })

    await test.step('a appends after the cursor and A after the line', async () => {
      await setText(page, BODY)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('a')
      await expect.poll(() => statusIcon(page)).toBe('vim-insert')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 2 })
      await page.keyboard.type('X')
      await expect.poll(() => text(page)).toBe(`aX${BODY.slice(1)}`)
      await page.keyboard.press('Escape')

      await page.keyboard.press('A')
      await expect.poll(() => statusIcon(page)).toBe('vim-insert')
      // "alpha beta" + the inserted X → the insert position is column 12.
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 12 })
      await page.keyboard.type('Y')
      await expect.poll(() => text(page)).toBe(`aXlpha betaY${BODY.slice(10)}`)
      await page.keyboard.press('Escape')
      await expect.poll(() => statusIcon(page)).toBe('vim-normal')
    })

    await test.step('dd deletes the line, p pastes it back, u undoes the paste', async () => {
      await setText(page, 'one\ntwo\nthree\n')
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 1))
      await page.keyboard.press('d')
      await page.keyboard.press('d')
      await expect.poll(() => text(page)).toBe('one\nthree\n')
      await page.keyboard.press('p')
      await expect.poll(() => text(page)).toBe('one\nthree\ntwo\n')
      await page.keyboard.press('u')
      await expect.poll(() => text(page)).toBe('one\nthree\n')
    })

    await test.step('Ctrl+F and PageUp/PageDown page the editor instead of opening find', async () => {
      await setText(page, TALL_BODY)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      const before = (await firstVisibleLine(page)) ?? 1
      await page.keyboard.press('Control+f')
      await expect
        .poll(() => firstVisibleLine(page), { message: 'the page-scroll left the viewport put' })
        .toBeGreaterThan(before)
      const afterCtrlF = (await firstVisibleLine(page)) ?? before
      await page.keyboard.press('PageDown')
      await expect.poll(() => firstVisibleLine(page)).toBeGreaterThan(afterCtrlF)
      const afterPageDown = (await firstVisibleLine(page)) ?? afterCtrlF
      await page.keyboard.press('PageUp')
      await expect.poll(() => firstVisibleLine(page)).toBeLessThan(afterPageDown)
      await expect.poll(() => workbench.getContextKey<boolean>('findWidgetVisible')).toBe(false)
      expect(await text(page)).toBe(TALL_BODY)
    })
  })

  test('Normal-mode search: / ? n N with live preview', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openEditor(page, workbench)
    await setVimModeEnabled(page, true)

    const body = 'bar one\nfoo two\nbaz foo\n'
    await setText(page, body)
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))

    await test.step('/ previews matches and Enter confirms', async () => {
      await page.keyboard.press('/')
      await page.keyboard.type('foo')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await page.keyboard.press('Enter')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await expect.poll(() => statusIcon(page)).toBe('vim-normal')
      await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('normal')
      await expect.poll(() => workbench.getContextKey<boolean>('findWidgetVisible')).toBe(false)
    })

    await test.step('n and N repeat with wrap-around', async () => {
      await page.keyboard.press('n')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 3, column: 5 })
      await page.keyboard.press('n')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await page.keyboard.press('N')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 3, column: 5 })
    })

    await test.step('/ skips the match under the cursor', async () => {
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 1))
      await page.keyboard.press('/')
      await page.keyboard.type('foo')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 3, column: 5 })
      await page.keyboard.press('Escape')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
    })

    await test.step('? searches backward', async () => {
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(3, 5))
      await page.keyboard.press('Shift+/')
      await page.keyboard.type('foo')
      await page.keyboard.press('Enter')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await page.keyboard.press('n')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 3, column: 5 })
    })

    await test.step('Escape restores the search origin', async () => {
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 5))
      await page.keyboard.press('/')
      await page.keyboard.type('foo')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 3, column: 5 })
      await page.keyboard.press('Escape')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 5 })
    })

    // Searching must never type into the buffer.
    await expect.poll(() => text(page)).toBe(body)
    await expect.poll(() => workbench.getContextKey<boolean>('findWidgetVisible')).toBe(false)
  })

  test('Normal-mode search honors smartcase and \\c', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openEditor(page, workbench)
    await setVimModeEnabled(page, true)

    const body = 'Foo one\nfoo two\nFOO three\n'
    await setText(page, body)
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))

    await test.step('lowercase queries use smartcase (ignore case)', async () => {
      await page.keyboard.press('/')
      await page.keyboard.type('foo')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await page.keyboard.press('Escape')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })
    })

    await test.step('uppercase queries are case-sensitive', async () => {
      await page.keyboard.press('/')
      await page.keyboard.type('FOO')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 3, column: 1 })
      await page.keyboard.press('Escape')
    })

    await test.step('\\c overrides the case policy for that search', async () => {
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('/')
      await page.keyboard.type('foo\\c')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await page.keyboard.press('Enter')
    })

    await expect.poll(() => text(page)).toBe(body)
  })

  test('turning the setting off restores plain typing', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openEditor(page, workbench)
    await setVimModeEnabled(page, true)
    await setVimModeEnabled(page, false)
    await expect.poll(() => statusIcon(page)).toBeUndefined()

    await setText(page, BODY)
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
    await page.keyboard.press('j')
    // With Vim off `j` is an ordinary character again.
    await expect.poll(() => text(page)).toBe(`j${BODY}`)
  })

  test('bare keys navigate the Explorer tree', async ({ page, workbench }) => {
    const dir = mkTempDir('universe-editor-e2e-vim-tree-')
    for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
      writeFileSync(join(dir, name), name, 'utf8')
    }
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    // Enable before the workspace opens: a settings write re-renders surfaces,
    // and the tree's selection must not be reset underneath the assertion.
    await setVimModeEnabled(page, true)
    await workbench.openWorkspace(dir)

    const alpha = page.locator('[role="treeitem"]', { hasText: 'alpha.txt' })
    await expect(alpha).toBeVisible({ timeout: 5000 })
    await alpha.click()
    // Let the post-workspace focus-restore window elapse, then click once more
    // so the tree (not the editor) owns the keyboard.
    await page.waitForTimeout(RESTORE_WINDOW_MS)
    await alpha.click()
    await expect(page.locator('[role="tree"][data-focused="true"]').first()).toBeVisible()
    await expect(alpha).toHaveAttribute('aria-selected', 'true')

    const selected = page.locator('[role="treeitem"][aria-selected="true"]')
    const expectSelected = (name: string) =>
      expect.poll(() => selected.textContent()).toContain(name)

    await page.keyboard.press('j')
    await expectSelected('beta.txt')
    await page.keyboard.press('j')
    await expectSelected('gamma.txt')
    await page.keyboard.press('k')
    await expectSelected('beta.txt')
    await page.keyboard.press('G')
    await expectSelected('gamma.txt')
    // `gg` lands on the first visible row, which is the workspace root folder.
    await page.keyboard.press('g')
    await page.keyboard.press('g')
    await expectSelected(basename(dir))

    // The vocabulary is claimed, not typed and not leaked to the global
    // dispatcher.
    await expect.poll(() => workbench.getContextKey<boolean>('findWidgetVisible')).toBe(false)
    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(false)
    await expect(page.locator('[role="tree"][data-focused="true"]').first()).toBeVisible()
  })
})
