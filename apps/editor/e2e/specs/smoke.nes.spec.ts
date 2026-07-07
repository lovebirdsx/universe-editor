/*---------------------------------------------------------------------------------------------
 *  Next Edit Suggestion smoke (P1).
 *
 *  Exercises the inline-EDIT (NES) wiring that holds without a real model — a fake
 *  provider returns an isInlineEdit item targeting a line away from the cursor:
 *    - Monaco natively renders the inline edit (inlineEditIsVisible mirrors true)
 *    - Tab JUMPS to the edit, then Tab ACCEPTS it (the global Tab arbitration
 *      between ai.inlineCompletion.jump and .commit under editContext)
 *    - the jump command is registered
 *
 *  The model-dependent generation/parse path is covered by unit tests on
 *  InlineCompletionService / nesEditParser / RecentEditsTracker.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

const JUMP = 'ai.inlineCompletion.jump'

function writeWorkspace(): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-nes-'))
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'line one\nline two\nline three\n')
  return { dir: dir.replace(/\\/g, '/'), filePath: filePath.replace(/\\/g, '/') }
}

test.describe('@p1 next edit suggestion', () => {
  test('contributes the jump command', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await expect
      .poll(() => page.evaluate((cmd) => window.__E2E__!.hasCommand(cmd), JUMP), {
        message: `command ${JUMP} should be registered`,
      })
      .toBe(true)
  })

  // @serial: this case opens a workspace (parcel watcher subscribe on the main
  // process). @parcel/watcher's windows backend has a cross-process native race —
  // concurrent subscribes/unsubscribes from several e2e worker instances can fault
  // (0xC0000005) the main process, surfacing elsewhere as "Target page has been
  // closed". Pin to one worker (same root cause as smoke.outline). See `pnpm e2e`.
  test(
    'renders an inline edit and Tab jumps then accepts',
    { tag: '@serial' },
    async ({ page, workbench }) => {
      await workbench.waitForRestored()

      const { dir, filePath } = writeWorkspace()
      await workbench.openWorkspace(dir)
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
      await expect(workbench.editor.monacoEditor).toBeVisible()
      await expect
        .poll(() => workbench.getActiveEditorText())
        .toBe('line one\nline two\nline three\n')

      await workbench.focusActiveEditorGroup()
      // Cursor on line 1; the edit targets line 3 (away from the cursor).
      await workbench.setActiveEditorCursor(1, 1)

      expect(
        await page.evaluate(() => window.__E2E__!.installFakeInlineEdit(3, 3, 'LINE THREE')),
      ).toBe(true)
      await page.evaluate(
        () => void window.__E2E__!.runCommand('editor.action.inlineSuggest.trigger'),
      )

      // Native inline-edit rendering: the mirrored context key flips on.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('inlineEditIsVisible')), {
          message: 'inline edit should become visible',
          timeout: 5000,
        })
        .toBe(true)
      expect(await page.evaluate(() => window.__E2E__!.getActiveInlineEditText())).toBe(
        'LINE THREE',
      )

      // Jump moves the cursor to the edit (line 3), then commit applies it. Driven
      // through the commands the Tab bindings invoke, polling the cursor in between
      // so the accept only runs once the jump has landed.
      await page.evaluate(() => void window.__E2E__!.runCommand('editor.action.inlineSuggest.jump'))
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber), {
          message: 'jump should move the cursor to the edit line',
          timeout: 5000,
        })
        .toBe(3)

      await page.evaluate(
        () => void window.__E2E__!.runCommand('editor.action.inlineSuggest.commit'),
      )

      await expect
        .poll(() => workbench.getActiveEditorText(), {
          message: 'commit should apply the inline edit',
          timeout: 5000,
        })
        .toBe('line one\nline two\nLINE THREE\n')
    },
  )
})
