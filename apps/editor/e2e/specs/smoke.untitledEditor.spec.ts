/*---------------------------------------------------------------------------------------------
 *  Untitled buffer parity smoke (P1): an unsaved new document must behave like
 *  a file editor — in-editor find, multicursor commands, and workspace search
 *  all work on its in-memory content.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URI } from '@universe-editor/platform'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'

const SEARCH = 'workbench.view.search'
const NEW_UNTITLED = 'workbench.action.files.newUntitledFile'
const DISK_NEEDLE = 'untitled-parity-disk-needle'
const BUFFER_NEEDLE = 'untitled-parity-buffer-needle'

function writeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-untitled-'))
  writeFileSync(join(dir, 'on-disk.txt'), `first\n${DISK_NEEDLE}\nlast\n`, 'utf8')
  return dir
}

/** Monaco mounts asynchronously after the input becomes active — retry until setValue lands. */
async function setEditorText(page: Page, text: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((t) => window.__E2E__!.setActiveEditorText(t), text))
    .toBe(true)
}

test.describe('@p1 untitled editor parity', () => {
  test('Ctrl+F opens find in an untitled buffer and jumps to the match', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    await workbench.runCommand(NEW_UNTITLED)
    await expect.poll(() => workbench.getActiveEditorUri()).toMatch(/^untitled:/)
    await setEditorText(page, 'alpha\nbeta needle\nomega')

    await page.keyboard.press('Control+f')
    await page.keyboard.type('needle')
    await page.keyboard.press('Escape')

    // The find widget leaves the editor selection on the match; without the
    // dispatch fix Ctrl+F is swallowed and 'needle' would have been typed into
    // the buffer at line 1 instead.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber))
      .toBe(2)
  })

  test('multicursor command edits all cursors in an untitled buffer', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    await workbench.runCommand(NEW_UNTITLED)
    await expect.poll(() => workbench.getActiveEditorUri()).toMatch(/^untitled:/)
    await setEditorText(page, 'one\ntwo')

    await workbench.runCommand('editor.action.insertCursorBelow')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorSelectionCount()))
      .toBe(2)
    await page.keyboard.type('x')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()))
      .toBe('xone\nxtwo')
  })

  test('workspace search finds matches that only exist in untitled / dirty buffers', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const dir = writeWorkspace()
    await workbench.openWorkspace(dir)

    // An untitled buffer whose needle exists nowhere on disk.
    await workbench.runCommand(NEW_UNTITLED)
    const untitledUri = await workbench.getActiveEditorUri()
    expect(untitledUri).toMatch(/^untitled:/)
    const untitledName = untitledUri!.split('/').pop()!
    await setEditorText(page, `only in memory: ${BUFFER_NEEDLE}`)

    await workbench.activityBar.click(SEARCH)
    const searchView = page.getByTestId('search-view')
    await expect(searchView).toBeVisible()
    await searchView.getByRole('textbox', { name: 'Search', exact: true }).fill('untitled-parity-')
    await expect(searchView.getByText(DISK_NEEDLE)).toBeVisible({ timeout: 10000 })
    const untitledRow = searchView.getByText(untitledName, { exact: true })
    await expect(untitledRow).toBeVisible({ timeout: 10000 })
    await expect(searchView.getByText(BUFFER_NEEDLE)).toBeVisible()

    // Activating the untitled result focuses the already-open buffer's match.
    await searchView.getByText(BUFFER_NEEDLE).click()
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(untitledUri)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber))
      .toBe(1)
  })

  test('workspace search reflects unsaved edits of an open file (dirty buffer wins over disk)', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const dir = writeWorkspace()
    await workbench.openWorkspace(dir)
    const fsPath = join(dir, 'on-disk.txt')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), fsPath)
    const fileUri = URI.file(fsPath).toString()
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(fileUri)

    // Unsaved edit: the buffer-only needle never reaches disk.
    await setEditorText(page, `first\nuntitled-parity-disk-needle\n${BUFFER_NEEDLE}\n`)

    await workbench.activityBar.click(SEARCH)
    const searchView = page.getByTestId('search-view')
    await expect(searchView).toBeVisible()
    await searchView.getByRole('textbox', { name: 'Search', exact: true }).fill(BUFFER_NEEDLE)
    // ripgrep cannot see this text; only the in-memory buffer search can.
    await expect(searchView.getByText(BUFFER_NEEDLE)).toBeVisible({ timeout: 10000 })
  })
})
