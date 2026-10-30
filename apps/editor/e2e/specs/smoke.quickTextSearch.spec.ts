/*---------------------------------------------------------------------------------------------
 *  Quick Search (Ctrl+Q) accept → open + reveal.
 *
 *  Regression: accepting a match opened the file but left the cursor at the top
 *  of the editor. The reveal polled FileEditorRegistry for one frame + 50ms,
 *  which a cold file's disk read + Monaco model + React mount routinely outlived,
 *  so the last retry silently gave up. The reveal now waits for the registry
 *  event, however long the mount takes.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { URI } from '@universe-editor/platform'
import { test, expect } from '../fixtures/electronApp.js'

const MATCH_LINE = 37
const NEEDLE = 'quick-search-probe-target'
const MATCH_TEXT = `    const ${NEEDLE} = 1`
const LINES = Array.from({ length: 60 }, (_, index) =>
  index + 1 === MATCH_LINE ? MATCH_TEXT : `line ${index + 1}`,
)
// 1-based, end-exclusive — ITextSearchRange and Monaco agree on this.
const START_COLUMN = MATCH_TEXT.indexOf(NEEDLE) + 1
const END_COLUMN = START_COLUMN + NEEDLE.length

test.describe('@p0 quick search', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'target.txt'), LINES.join('\n'))
      },
    },
  })

  test('Ctrl+Q accept opens the file and reveals the match range', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (!launchWorkspace) throw new Error('workspaceSeeder 未生效')
    await workbench.waitForRestored()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 10_000,
      })
      .toBe(URI.file(launchWorkspace.dir).toString())
    await workbench.waitForBootstrapFocusSettled()

    await page.keyboard.press('Control+q')
    await workbench.quickInput.waitForVisible()
    await workbench.quickInput.input.fill(NEEDLE)

    const option = workbench.quickInput.dialog.getByRole('option', {
      name: new RegExp(NEEDLE),
    })
    await expect(option).toBeVisible({ timeout: 15_000 })
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect
      .poll(() => workbench.getActiveEditorUri(), { timeout: 10_000 })
      .toBe(URI.file(launchWorkspace.file('target.txt')).toString())

    // The whole range, not just the line: a jump that lands on the right line
    // with the wrong column is still a broken jump.
    const expectedSelection = {
      startLineNumber: MATCH_LINE,
      startColumn: START_COLUMN,
      endLineNumber: MATCH_LINE,
      endColumn: END_COLUMN,
    }
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorSelection()), {
        timeout: 10_000,
      })
      .toEqual(expectedSelection)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber ?? -1), {
        timeout: 10_000,
      })
      .toBe(MATCH_LINE)
    // applyEditorSelection focuses the editor once it mounts.
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
  })
})
