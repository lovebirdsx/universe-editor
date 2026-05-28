/*---------------------------------------------------------------------------------------------
 *  History navigation smoke (@p0).
 *
 *  Reproduces: open a (preview) → move cursor in a → open b (preview, replaces a)
 *  → GoBack should land on a with a single tab — NOT open a duplicate "a" tab
 *  alongside b.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p0 history navigation', () => {
  test('GoBack after preview-replacing the previous file reuses the slot (no duplicate tab)', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-history-'))
    const fileA = join(tmpDir, 'a.txt')
    const fileB = join(tmpDir, 'b.txt')
    writeFileSync(fileA, Array.from({ length: 60 }, (_, i) => `line ${i + 1} in a`).join('\n'))
    writeFileSync(fileB, Array.from({ length: 10 }, (_, i) => `line ${i + 1} in b`).join('\n'))

    try {
      // Step 1: open a as preview (Explorer single-click semantics).
      await page.evaluate(([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: false }), [
        fileA.replace(/\\/g, '/'),
      ] as const)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('a.txt')
      await expect(workbench.editor.monacoEditor).toBeVisible()

      // Step 2: move cursor to line 30 (crosses HistoryContribution's 10-line threshold)
      //         and wait past the 250 ms debounce so the entry is recorded.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorCursor(30, 1)))
        .toBe(true)
      await page.waitForTimeout(400)
      await expect.poll(() => workbench.getContextKey<boolean>('canGoBack')).toBe(false)
      // Cursor record alone is one entry; canGoBack needs >=2. We need the
      // open-b record below to flip it. Sanity-check the back stack indirectly
      // via the count of editors after we open b.

      // Step 3: open b as preview — replaces a in the preview slot, disposing a.
      await page.evaluate(([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: false }), [
        fileB.replace(/\\/g, '/'),
      ] as const)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('b.txt')
      // Single tab confirms preview-replace happened.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveGroupEditorCount()))
        .toBe(1)

      // Nudge cursor inside b so the b-side entry definitely lands.
      // Pick a line different from b's initial cursor (1,1) so Monaco fires a
      // cursor-change event the debounced recorder can act on.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorCursor(5, 1)))
        .toBe(true)
      await page.waitForTimeout(400)
      await expect.poll(() => workbench.getContextKey<boolean>('canGoBack')).toBe(true)

      // Step 4: GoBack — should bring back a in the same preview slot.
      await workbench.runCommand('workbench.action.goBack')

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('a.txt')

      // The critical assertion: only one tab open. The bug manifests as
      // [b(preview), a(pinned)] — count would be 2.
      const uris = await page.evaluate(() => window.__E2E__!.getActiveGroupEditorUris())
      expect(
        uris,
        `active group should contain only a.txt, got ${JSON.stringify(uris)}`,
      ).toHaveLength(1)
      expect(uris[0]).toContain('a.txt')
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* best-effort */
      }
    }
  })

  test('GoBack after opening b on top of a (no cursor movement) returns to a', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-history-open-'))
    const fileA = join(tmpDir, 'a.txt')
    const fileB = join(tmpDir, 'b.txt')
    writeFileSync(fileA, 'content of a\n')
    writeFileSync(fileB, 'content of b\n')

    try {
      await page.evaluate(([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: true }), [
        fileA.replace(/\\/g, '/'),
      ] as const)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('a.txt')

      await page.evaluate(([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: true }), [
        fileB.replace(/\\/g, '/'),
      ] as const)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('b.txt')

      // No cursor manipulation at all — just open a, open b. GoBack must work.
      await expect.poll(() => workbench.getContextKey<boolean>('canGoBack')).toBe(true)

      await workbench.runCommand('workbench.action.goBack')

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('a.txt')
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* best-effort */
      }
    }
  })

  test('GoBack across a non-text editor (Settings) returns to it', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-history-settings-'))
    const fileA = join(tmpDir, 'a.txt')
    writeFileSync(fileA, 'content of a\n')

    try {
      await workbench.runCommand('workbench.action.openSettings')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
        .toBe('settings')

      await page.evaluate(([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: true }), [
        fileA.replace(/\\/g, '/'),
      ] as const)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
        .toContain('a.txt')

      await expect.poll(() => workbench.getContextKey<boolean>('canGoBack')).toBe(true)

      await workbench.runCommand('workbench.action.goBack')

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
        .toBe('settings')
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* best-effort */
      }
    }
  })
})
