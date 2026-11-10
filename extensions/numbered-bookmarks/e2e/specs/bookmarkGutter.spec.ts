/*---------------------------------------------------------------------------------------------
 *  Numbered Bookmarks gutter smoke.
 *
 *  The bookmark is painted as a zero-width whole-line grid decoration. Monaco
 *  tracks that range across edits with the default `AlwaysGrowsWhenTypingAtEdges`
 *  stickiness: inserting text exactly at the range start (Copy Line Down inserts
 *  at the first selected line's start) grows the range over the inserted block,
 *  and the glyph margin then paints the same ribbon on every line of the range.
 *  The extension must re-apply the stored single-line range after the change
 *  reaches the extension host.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { WorkbenchPO } from '@universe-editor/e2e-harness'
import { expect, test } from '../fixtures/bookmarksApp.js'

const SOURCE = '1\n2\n3\n'
const FILE_NAME = 'lines.txt'
const GUTTER_CLASS_PREFIX = 'ext-deco-gutter-'

test.use({
  workspaceSeeder: {
    seed(dir) {
      writeFileSync(join(dir, FILE_NAME), SOURCE)
    },
  },
})

/** Monaco keeps the file's detected EOL; CRLF checkouts must still compare equal. */
function normalizeEol(text: string | undefined): string | undefined {
  return text?.replace(/\r\n/g, '\n')
}

/**
 * Open the seeded file and return the model URI — the exact string
 * `getEditorDecorations` needs to resolve the Monaco model. `launchWorkspace.file`
 * is an fs path, which `Uri.parse` would not map back onto the model.
 */
async function openSeededFile(
  page: Page,
  workbench: WorkbenchPO,
  launchWorkspace: { file(rel: string): string },
): Promise<string> {
  await workbench.waitForRestored()
  const fsPath = launchWorkspace.file(FILE_NAME)
  await page.evaluate((p) => window.__E2E__!.openFileUri(p), fsPath)
  await expect.poll(() => workbench.getActiveEditorUri()).toContain(FILE_NAME)
  // The cursor/selection probes need the Monaco instance registered, which trails
  // the editor input becoming active by a React mount.
  await expect.poll(() => workbench.getActiveEditorText().then(normalizeEol)).toBe(SOURCE)
  const uri = await workbench.getActiveEditorUri()
  if (!uri) throw new Error('no active editor uri after opening the seeded file')
  return uri
}

/** Bookmark gutter decorations as `[startLine, startColumn, endLine, endColumn]`. */
async function bookmarkGlyphs(page: Page, uri: string): Promise<number[][]> {
  const decorations = await page.evaluate((u) => window.__E2E__!.getEditorDecorations(u), uri)
  return decorations
    .filter((d) => d.glyphMarginClassName?.startsWith(GUTTER_CLASS_PREFIX))
    .map((d) => [d.startLineNumber, d.startColumn, d.endLineNumber, d.endColumn])
}

/**
 * Wait for the extension host to translate the contributed command into the
 * workbench registry. `runCommand` on an unregistered id is a silent no-op, and
 * that translation runs asynchronously after the host reports ready.
 */
async function waitForToggleCommand(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((id) => window.__E2E__!.hasCommand(id), 'numberedBookmarks.toggleBookmark0'),
      { timeout: 15_000 },
    )
    .toBe(true)
}

test('toggle paints exactly one gutter ribbon on the cursor line @p1', async ({
  page,
  workbench,
  launchWorkspace,
}) => {
  test.slow()
  if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
  const uri = await openSeededFile(page, workbench, launchWorkspace)
  expect(await workbench.setActiveEditorCursor(1, 1)).toBe(true)
  await waitForToggleCommand(page)

  await workbench.runCommand('numberedBookmarks.toggleBookmark0')
  await expect.poll(() => bookmarkGlyphs(page, uri), { timeout: 15_000 }).toEqual([[1, 1, 1, 1]])

  await workbench.runCommand('numberedBookmarks.toggleBookmark0')
  await expect.poll(() => bookmarkGlyphs(page, uri), { timeout: 15_000 }).toEqual([])
})

test('copy lines down keeps one ribbon on the bookmarked line @regression', async ({
  page,
  workbench,
  launchWorkspace,
}) => {
  test.slow()
  if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
  const uri = await openSeededFile(page, workbench, launchWorkspace)

  expect(await workbench.setActiveEditorCursor(1, 1)).toBe(true)
  await waitForToggleCommand(page)
  await workbench.runCommand('numberedBookmarks.toggleBookmark0')
  await expect.poll(() => bookmarkGlyphs(page, uri), { timeout: 15_000 }).toEqual([[1, 1, 1, 1]])

  // Three whole lines including the trailing newline (monaco models a final
  // newline as an empty fourth line), then Copy Line Down.
  expect(await workbench.setActiveEditorSelection(1, 1, 4, 1)).toBe(true)
  await workbench.runCommand('editor.action.copyLinesDownAction')
  await expect
    .poll(() => workbench.getActiveEditorText().then(normalizeEol), { timeout: 15_000 })
    .toBe('1\n2\n3\n1\n2\n3\n')

  // Before the fix this was `[[1, 1, 4, 1]]`: one decoration stretched over the
  // inserted block, hence four ribbons.
  await expect.poll(() => bookmarkGlyphs(page, uri), { timeout: 15_000 }).toEqual([[1, 1, 1, 1]])
})
