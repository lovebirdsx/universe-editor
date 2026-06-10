/*---------------------------------------------------------------------------------------------
 *  S12 — EditorResolverService (P1).
 *
 *  验证 EditorResolverService 按 glob 分发正确的 EditorInput，并通过
 *  "Reopen With..." 命令切换编辑器类型。
 *
 *  步骤：
 *    1. 注册 dummy editor（`**\/*.dummy` → typeId='dummyEditor'，priority=100）
 *    2. 打开一个 .dummy 文件，断言 getActiveEditorTypeId() === 'dummyEditor'
 *    3. 触发 "Reopen With..." 命令 → 选 'File Editor'
 *    4. 断言 getActiveEditorTypeId() === 'file'
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p1 editorResolver', () => {
  test('resolves .dummy file to dummyEditor via resolver', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    // Create a temp .dummy file on disk.
    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-resolver-'))
    const dummyFile = join(tmpDir, 'test.dummy')
    writeFileSync(dummyFile, '')
    // Normalise to forward slashes (URI.file normalises internally, but let's be explicit).
    const dummyFsPath = dummyFile.replace(/\\/g, '/')

    // Register the dummy editor in the renderer via the E2E probe.
    await page.evaluate(() => {
      window.__E2E__!.registerDummyEditor('**/*.dummy', 'dummyEditor')
    })

    // Open the file through the EditorResolverService (bypasses native dialog).
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), dummyFsPath)

    // Resolver should have dispatched to dummyEditor.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('dummyEditor')
  })

  test('"Reopen With..." switches from dummyEditor back to file', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-reopen-'))
    const dummyFile = join(tmpDir, 'chart.dummy')
    writeFileSync(dummyFile, '')
    const dummyFsPath = dummyFile.replace(/\\/g, '/')

    await page.evaluate(() => {
      window.__E2E__!.registerDummyEditor('**/*.dummy', 'dummyEditor')
    })

    // Open dummy file — resolver picks dummyEditor (priority 100 > builtin 1).
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), dummyFsPath)

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('dummyEditor')

    // "Reopen With..." — fire-and-forget because QuickPick awaits user input.
    await page.evaluate((fsPath) => {
      const uri = { scheme: 'file', path: fsPath, authority: '', query: '', fragment: '' }
      void window.__E2E__!.runCommand('workbench.action.reopenWith', { resource: uri })
    }, dummyFsPath)

    await workbench.quickInput.waitForVisible()

    // Type "File" to filter down to "File Editor". Wait for the filtered option
    // to actually render+focus before confirming — typing then pressing Enter
    // immediately races the async filter on a slow CI runner (the old list may
    // still be showing, so Enter picks the wrong item or a stale one).
    await page.keyboard.type('File')
    const fileOption = page.getByRole('option', { name: 'File Editor' })
    await expect(fileOption).toBeVisible()
    await page.keyboard.press('Enter')

    await workbench.quickInput.waitForHidden()

    // After reopen, the active editor should be the 'file' typeId.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('file')
  })
})
