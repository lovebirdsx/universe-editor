/*---------------------------------------------------------------------------------------------
 *  S — Markdown preview (P1).
 *
 *  验证 markdown 预览命令：
 *    1. 打开一个 .md 文件 → activeEditorLanguageId == 'markdown'
 *    2. "Open Preview" → 当前组只剩 markdown.preview，源文件 tab 消失
 *    3. "Open Source" → 从预览切回，当前组只剩源文件 tab
 *    4. "Open Preview to the Side" → 分裂出新组，活动编辑器为 markdown.preview
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

function writeTempMarkdown(): string {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-md-'))
  const file = join(dir, 'note.md')
  writeFileSync(file, '# Title\n\nsome **bold** text\n')
  return file.replace(/\\/g, '/')
}

test.describe('@p1 markdown preview', () => {
  test('Open Preview replaces source tab with preview tab', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const mdFsPath = writeTempMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 5000 })
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    // Source tab must be gone — only the preview remains
    await expect
      .poll(() => workbench.getContextKey<number>('groupEditorsCount'), { timeout: 5000 })
      .toBe(1)
  })

  test('Open Source switches back from preview to source', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const mdFsPath = writeTempMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 5000 })
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    await workbench.runCommand('workbench.action.markdown.showSource')

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 5000 })
      .toBe('markdown')

    // Preview tab must be gone — only the source remains
    await expect
      .poll(() => workbench.getContextKey<number>('groupEditorsCount'), { timeout: 5000 })
      .toBe(1)
  })

  test('Open Preview to the Side splits into a new group', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const mdFsPath = writeTempMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 5000 })
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreviewToSide')

    await expect
      .poll(() => workbench.getContextKey<boolean>('editorPartMultipleEditorGroups'), {
        timeout: 5000,
      })
      .toBe(true)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')
  })
})
