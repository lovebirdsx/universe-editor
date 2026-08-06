/*---------------------------------------------------------------------------------------------
 *  findWordAtCursor smoke (@p1).
 *
 *  Alt+Down/Alt+Up jump between occurrences of the word at the cursor without
 *  opening the find widget: collapsed cursor → whole-word, case-sensitive jumps
 *  that keep the cursor's relative column; single-line selection →
 *  case-insensitive substring jumps that select the match.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

test.describe('findWordAtCursor', () => {
  test('strict jumps walk whole-word occurrences and keep the cursor delta @p1', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-findword-'))
    const file = join(tmpDir, 'words.txt')
    // "foo" ×3 (line1 col1/col9, line2 col5); "foobar" on line3 must never match.
    writeFileSync(file, 'foo bar foo\nbaz foo qux\nfoobar quux\n')

    try {
      await page.evaluate(([fsPath]) => window.__E2E__!.openFileUri(fsPath!), [
        file.replace(/\\/g, '/'),
      ] as const)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('words.txt')
      await expect(workbench.editor.monacoEditor).toBeVisible()

      const cursor = () => page.evaluate(() => window.__E2E__!.getActiveEditorCursor())

      // Cursor inside the first "foo" at column 2 → delta 1.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 2)))
        .toBe(true)

      await workbench.runCommand('findWordAtCursor.next')
      await expect.poll(cursor).toEqual({ lineNumber: 1, column: 10 })

      await workbench.runCommand('findWordAtCursor.next')
      await expect.poll(cursor).toEqual({ lineNumber: 2, column: 6 })

      // Wrap-around: next from the last occurrence lands back on the first.
      await workbench.runCommand('findWordAtCursor.next')
      await expect.poll(cursor).toEqual({ lineNumber: 1, column: 2 })

      // Previous walks backwards; "foobar" (line 3) is a substring hit and is skipped.
      await workbench.runCommand('findWordAtCursor.previous')
      await expect.poll(cursor).toEqual({ lineNumber: 2, column: 6 })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('loose jump from a selection selects the case-insensitive match @p1', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-findword-loose-'))
    const file = join(tmpDir, 'loose.txt')
    writeFileSync(file, 'xx alpha yy ALPHA zz alpha\n')

    try {
      await page.evaluate(([fsPath]) => window.__E2E__!.openFileUri(fsPath!), [
        file.replace(/\\/g, '/'),
      ] as const)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('loose.txt')
      await expect(workbench.editor.monacoEditor).toBeVisible()

      const selection = () => page.evaluate(() => window.__E2E__!.getActiveEditorSelection())

      // Select the first "alpha" (cols 4..9).
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorSelection(1, 4, 1, 9)))
        .toBe(true)

      await workbench.runCommand('findWordAtCursor.next')
      await expect
        .poll(selection)
        .toEqual({ startLineNumber: 1, startColumn: 13, endLineNumber: 1, endColumn: 18 })

      await workbench.runCommand('findWordAtCursor.previous')
      await expect
        .poll(selection)
        .toEqual({ startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 9 })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('sole occurrence keeps the cursor in place @p1', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-findword-sole-'))
    const file = join(tmpDir, 'sole.txt')
    writeFileSync(file, 'unique word here\n')

    try {
      await page.evaluate(([fsPath]) => window.__E2E__!.openFileUri(fsPath!), [
        file.replace(/\\/g, '/'),
      ] as const)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('sole.txt')
      await expect(workbench.editor.monacoEditor).toBeVisible()

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 2)))
        .toBe(true)

      await workbench.runCommand('findWordAtCursor.next')
      // "No more matches." — the cursor must not move (the toast is not asserted).
      await page.waitForTimeout(300)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()))
        .toEqual({ lineNumber: 1, column: 2 })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
