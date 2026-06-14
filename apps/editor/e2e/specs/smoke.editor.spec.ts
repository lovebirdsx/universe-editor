/*---------------------------------------------------------------------------------------------
 *  S3 — New untitled file mounts a Monaco editor (P0).
 *
 *  workbench.action.files.newUntitledFile 应:
 *    - 让 .monaco-editor 与 file-editor 容器出现
 *    - 让 getActiveEditorUri() 返回以 'untitled:' 开头的 URI
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p0 editor', () => {
  test('newUntitledFile mounts Monaco and exposes untitled: URI', async ({ workbench }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')

    await expect(workbench.editor.fileEditor).toBeVisible()
    await expect(workbench.editor.monacoEditor).toBeVisible()

    const uri = await workbench.editor.activeUri()
    expect(uri).toBeDefined()
    expect(uri!.startsWith('untitled:')).toBe(true)
  })
})
