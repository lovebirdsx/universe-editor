/*---------------------------------------------------------------------------------------------
 *  Diff editor hunk navigation from outside the editor (P1).
 *
 *  The diff editor is often previewed from a view that keeps focus (Commit
 *  Changes / SCM). Alt+PageDown/Up must still walk hunks there instead of
 *  requiring focus inside Monaco — the binding is gated on
 *  `textCompareEditorVisible`, not on `editorTextFocus`.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/sharedApp.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '@universe-editor/e2e-harness'
import { focusExplorerTree, setVimEnabled, statusText } from '../pages/vimHelpers.js'

const LINE_COUNT = 120
const FIRST_CHANGE_LINE = 40
const SECOND_CHANGE_LINE = 80

function makeOriginal(): string {
  return Array.from({ length: LINE_COUNT }, (_, i) => `line ${i + 1}`).join('\n')
}

function makeModified(): string {
  return Array.from({ length: LINE_COUNT }, (_, i) => {
    const lineNumber = i + 1
    return lineNumber === FIRST_CHANGE_LINE || lineNumber === SECOND_CHANGE_LINE
      ? `line ${lineNumber} CHANGED`
      : `line ${lineNumber}`
  }).join('\n')
}

async function cursorLine(page: import('@playwright/test').Page): Promise<number | undefined> {
  const state = await page.evaluate(() => window.__E2E__!.getActiveDiffViewState())
  return state?.cursorLine
}

test.describe('@p1 diff keyboard navigation', () => {
  test('Alt+PageDown/Up walks hunks while focus stays in a view', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const original = makeOriginal()
    const modified = makeModified()

    await page.evaluate(
      ([original, modified]) =>
        window.__E2E__!.runCommand('_workbench.openDiff', {
          title: 'long.txt',
          originalUri: 'file:///ws/long.txt',
          original,
          modified,
          pinned: true,
        }),
      [original, modified] as const,
    )

    // Opening a diff auto-reveals the first hunk.
    await expect.poll(() => cursorLine(page), { timeout: 10_000 }).toBe(FIRST_CHANGE_LINE)

    await workbench.runCommand('workbench.action.focusSideBar')
    await expect.poll(() => workbench.getContextKey<string>('focusedPart')).toBe('sideBar')
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(false)

    await page.keyboard.press('Alt+PageDown')
    await expect.poll(() => cursorLine(page), { timeout: 10_000 }).toBe(SECOND_CHANGE_LINE)

    await page.keyboard.press('Alt+PageUp')
    await expect.poll(() => cursorLine(page), { timeout: 10_000 }).toBe(FIRST_CHANGE_LINE)

    // Navigation must not steal focus back into the diff editor.
    expect(await workbench.getContextKey<string>('focusedPart')).toBe('sideBar')
  })

  test('Vim ]c / [c walks hunks from a list surface', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await page.evaluate(() => window.__E2E__!.whenUserSettingsInitialized())
    await workbench.runCommand('_workbench.updateConfiguration', 'vim.enabled', true)
    await expect.poll(() => workbench.getContextKey<boolean>('vimEnabled')).toBe(true)

    const dir = mkTempDir('ue2-diffvimnav-')
    writeFileSync(join(dir, 'a.txt'), 'a\n', 'utf8')
    await workbench.openWorkspace(dir)
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const original = makeOriginal()
    const modified = makeModified()

    // Focus the Explorer tree first — a `list` surface. Single-clicking a row
    // opens the file, so open the diff afterwards with `preserveFocus` to keep
    // the tree focused while the diff becomes the active editor.
    await focusExplorerTree(page, 'a.txt')

    await page.evaluate(
      ([original, modified]) =>
        window.__E2E__!.runCommand('_workbench.openDiff', {
          title: 'long.txt',
          originalUri: 'file:///ws/long.txt',
          original,
          modified,
          pinned: true,
          preserveFocus: true,
        }),
      [original, modified] as const,
    )
    await expect.poll(() => cursorLine(page), { timeout: 10_000 }).toBe(FIRST_CHANGE_LINE)

    // The editor surface never sees these strokes, so the list keymap must route
    // them to the compare editor.
    await page.keyboard.press(']')
    await page.keyboard.press('c')
    await expect.poll(() => cursorLine(page), { timeout: 10_000 }).toBe(SECOND_CHANGE_LINE)

    await page.keyboard.press('[')
    await page.keyboard.press('c')
    await expect.poll(() => cursorLine(page), { timeout: 10_000 }).toBe(FIRST_CHANGE_LINE)

    // The single-chord alternative works on the same list surface.
    await page.keyboard.press('Alt+j')
    await expect.poll(() => cursorLine(page), { timeout: 10_000 }).toBe(SECOND_CHANGE_LINE)

    await page.keyboard.press('Alt+k')
    await expect.poll(() => cursorLine(page), { timeout: 10_000 }).toBe(FIRST_CHANGE_LINE)

    expect(await workbench.getContextKey<string>('focusedPart')).toBe('sideBar')
  })

  test('Vim inside a read-only snapshot diff moves and refuses writes', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    await expect.poll(() => workbench.getContextKey<boolean>('vimEnabled')).toBe(true)

    const original = makeOriginal()
    const modified = makeModified()

    // No `liveModified` → both sides are read-only snapshots, like Commit Changes.
    // No `preserveFocus` → focus lands in the modified pane.
    await page.evaluate(
      ([original, modified]) =>
        window.__E2E__!.runCommand('_workbench.openDiff', {
          title: 'long.txt',
          originalUri: 'file:///ws/long.txt',
          original,
          modified,
          pinned: true,
        }),
      [original, modified] as const,
    )

    // The diff auto-reveals the first hunk; wait for focus before driving Vim.
    await expect.poll(() => cursorLine(page), { timeout: 10_000 }).toBe(FIRST_CHANGE_LINE)
    await expect.poll(() => workbench.getContextKey<string>('focusedPart')).toBe('editorArea')

    // The first stroke activates the editor surface and shows the mode in the status bar.
    await page.keyboard.press('j')
    await expect.poll(() => statusText(page)).toBe('NORMAL')
    await expect.poll(() => cursorLine(page)).toBe(FIRST_CHANGE_LINE + 1)

    // ]c / [c route through the editor kernel to workbench.action.editor.*Change.
    await page.keyboard.press(']')
    await page.keyboard.press('c')
    await expect.poll(() => cursorLine(page)).toBe(SECOND_CHANGE_LINE)

    await page.keyboard.press('[')
    await page.keyboard.press('c')
    await expect.poll(() => cursorLine(page)).toBe(FIRST_CHANGE_LINE)

    // Write commands are refused on the read-only snapshot: no text change, no Insert.
    const before = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
    expect(before).toBeDefined()
    await page.keyboard.press('x')
    await page.keyboard.press('d')
    await page.keyboard.press('d')
    expect(await page.evaluate(() => window.__E2E__!.getActiveDiffContent())).toEqual(before)
    await expect.poll(() => statusText(page)).toBe('NORMAL')

    expect(await workbench.getContextKey<string>('focusedPart')).toBe('editorArea')
  })
})
