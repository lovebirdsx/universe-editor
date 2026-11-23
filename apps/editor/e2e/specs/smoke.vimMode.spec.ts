/*---------------------------------------------------------------------------------------------
 *  Vim mode (@p1).
 *
 *  Guards the Normal/Insert mode contract behind `vim.enabled`:
 *  bare-key navigation, operators, the Insert hand-off, the status-bar mode
 *  indicator, Ctrl+F paging (which must page the editor instead of opening the
 *  find widget), list navigation on the Explorer tree, and — most importantly —
 *  that turning the setting off restores plain typing.
 *
 *  The setting is USER scope and the shared fixture rewrites settings.json
 *  between tests, so each test opts in on its own.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'
import {
  cursor,
  expectStableFor,
  firstVisibleLine,
  foldingState,
  setText,
  setVimEnabled,
  statusIcon,
  text,
  visibleLineCount,
} from '../pages/vimHelpers.js'

/** 5 lines including the trailing empty one; word boundaries are predictable. */
const BODY = 'alpha beta\ngamma delta\nepsilon zeta\neta theta\n'

/** Taller than any editor viewport, so a page-scroll has somewhere to go. */
const TALL_BODY = `${Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')}\n`

interface WorkbenchLike {
  openWorkspace(path: string): Promise<void>
  getContextKey<T = unknown>(key: string): Promise<T>
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

/** JSON has a folding provider; plain text has none. */
async function openJsonEditor(page: Page, workbench: WorkbenchLike, body: string): Promise<void> {
  const dir = mkTempDir('universe-editor-e2e-vim-fold-')
  const filePath = join(dir, 'fold.json')
  writeFileSync(filePath, body, 'utf8')
  await workbench.openWorkspace(dir)
  await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('activeEditorLanguageId')))
    .toBe('json')
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
    await setVimEnabled(page, true)

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

  test('Normal-mode search: / ? n N, smartcase and \\c', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openEditor(page, workbench)
    await setVimEnabled(page, true)

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

    // Searching must never type into the buffer.
    await expect.poll(() => text(page)).toBe(body)

    // Case policy is unit-covered; one chained pass proves it reaches the real editor.
    const caseBody = 'Foo one\nfoo two\nFOO three\n'
    await setText(page, caseBody)
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))

    await test.step('lowercase uses smartcase, uppercase is case-sensitive, \\c overrides', async () => {
      await page.keyboard.press('/')
      await page.keyboard.type('foo')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await page.keyboard.press('Escape')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 1, column: 1 })

      await page.keyboard.press('/')
      await page.keyboard.type('FOO')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 3, column: 1 })
      await page.keyboard.press('Escape')

      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('/')
      await page.keyboard.type('foo\\c')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await page.keyboard.press('Enter')
    })

    await expect.poll(() => text(page)).toBe(caseBody)
    await expect.poll(() => workbench.getContextKey<boolean>('findWidgetVisible')).toBe(false)
  })

  /**
   * The `/` box is a plain overlay widget, so it takes `.overlayWidgets` paint
   * order. Monaco's sticky-scroll widget is an overlay too but carries
   * `z-index: 4`; a box without its own z-index paints underneath the sticky
   * lines. Playwright's visibility check cannot see occlusion, so hit-test the
   * input's center — the only faithful assertion for a stacking bug.
   */
  test('Normal-mode search box is not obscured by sticky scroll @regression', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    // Two nested indentation scopes: `root` + `child` stay pinned while the
    // leaves scroll, so at least two sticky rows cover the box's vertical band.
    const scopedBody = `root\n  child\n${Array.from({ length: 120 }, (_, i) => `    leaf ${i + 1}`).join('\n')}\n`
    await openEditor(page, workbench, scopedBody)
    await setVimEnabled(page, true)

    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(100, 5))
    await expect
      .poll(() =>
        page.evaluate(() => {
          const sticky = document.querySelector<HTMLElement>('.monaco-editor .sticky-widget')
          return sticky?.clientHeight ?? 0
        }),
      )
      .toBeGreaterThan(0)

    await page.keyboard.press('/')
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.vim-search-input') !== null))
      .toBe(true)

    const hit = await page.evaluate(() => {
      const input = document.querySelector<HTMLElement>('.vim-search-input')
      if (!input) return { reachedInput: false, topClass: null as string | null }
      const rect = input.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return {
        reachedInput: top !== null && (top === input || input.contains(top)),
        topClass: top?.getAttribute('class') ?? null,
      }
    })
    expect(hit.reachedInput, `top element over the search input: ${hit.topClass}`).toBe(true)
  })

  test('mode is remembered per editor surface', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    const dir = mkTempDir('universe-editor-e2e-vim-memory-')
    const fileA = join(dir, 'a.txt')
    const fileB = join(dir, 'b.txt')
    writeFileSync(fileA, BODY, 'utf8')
    writeFileSync(fileB, BODY, 'utf8')
    await workbench.openWorkspace(dir)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), fileA)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')))
      .toBe(true)
    await setVimEnabled(page, true)
    await expect.poll(() => statusIcon(page)).toBe('vim-normal')

    await test.step('Insert survives a focus move to another surface', async () => {
      await page.keyboard.press('i')
      await expect.poll(() => statusIcon(page)).toBe('vim-insert')
      await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('insert')

      await workbench.runCommand('workbench.action.focusSideBar')
      // Leaving the editor only clears/retargets the active-surface keys; the
      // editor's own memory must not be reset to Normal.
      await expect.poll(() => workbench.getContextKey<string>('vimMode')).not.toBe('insert')
      await expect.poll(() => workbench.getContextKey<string>('focusedPart')).toBe('sideBar')

      await workbench.runCommand('workbench.action.focusActiveEditorGroup')
      await expect.poll(() => statusIcon(page)).toBe('vim-insert')
      await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('insert')
    })

    await test.step('another editor starts Normal and each keeps its own mode', async () => {
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), fileB)
      await expect.poll(() => statusIcon(page)).toBe('vim-normal')
      await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('normal')

      await page.evaluate((p) => window.__E2E__!.openFileUri(p), fileA)
      await expect.poll(() => statusIcon(page)).toBe('vim-insert')

      // Esc only changes A; returning to B must still find Normal.
      await page.keyboard.press('Escape')
      await expect.poll(() => statusIcon(page)).toBe('vim-normal')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), fileB)
      await expect.poll(() => statusIcon(page)).toBe('vim-normal')
    })
  })

  test('j/k across a collapsed fold keep it closed @regression', async ({ page, workbench }) => {
    test.slow()
    const body = '{\n  "fold": {\n    "a": 1,\n    "b": 2\n  },\n  "after": 3\n}'
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openJsonEditor(page, workbench, body)

    // JSON folding ranges arrive asynchronously; folding before they land is a
    // silent no-op.
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 1))
    await expect
      .poll(() => foldingState(page), { timeout: 20_000 })
      .toMatchObject({ regionAtCursor: true })
    await page.keyboard.press('Control+Shift+Alt+f')
    await expect.poll(() => foldingState(page)).toMatchObject({ collapsedCount: 1 })
    // The JSON provider's exact region boundaries are not the contract here;
    // only that rows are hidden and stay hidden after the Vim motions.
    const foldedVisibleLines = (await visibleLineCount(page)) ?? 0
    expect(foldedVisibleLines).toBeLessThan(7)

    await setVimEnabled(page, true)
    await expect.poll(() => statusIcon(page)).toBe('vim-normal')

    // Monaco unfolds a hidden cursor 200 ms after the move, so a single read at
    // t=0 would pass before the regression can fire; sample across that window.
    const expectFoldKept = () =>
      expectStableFor(
        async () => ({
          collapsedCount: (await foldingState(page))?.collapsedCount,
          visibleLines: await visibleLineCount(page),
          text: await text(page),
        }),
        { collapsedCount: 1, visibleLines: foldedVisibleLines, text: body },
      )

    await test.step('j skips the fold and leaves it collapsed', async () => {
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('j')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await page.keyboard.press('j')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 5, column: 1 })

      await expectFoldKept()
    })

    await test.step('k skips the fold in the other direction', async () => {
      await page.keyboard.press('k')
      await expect.poll(() => cursor(page)).toEqual({ lineNumber: 2, column: 1 })
      await expectFoldKept()
    })
  })
})
