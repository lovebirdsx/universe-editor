/*---------------------------------------------------------------------------------------------
 *  HTML preview smoke (P1).
 *
 *  验证 .html 文件默认以源码文本编辑器（typeId='file'）打开，
 *  执行 workbench.action.html.openPreview 后切换为 HTML 预览（typeId='html.preview'），
 *  且预览视图（iframe 宿主）实际挂载。
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

const HTML_DOC = `<!DOCTYPE html>
<html>
  <head><link rel="stylesheet" href="./style.css" /></head>
  <body><h1 id="title">Hello</h1><img src="./pic.png" alt="p" /></body>
</html>`

test.describe('@p1 html preview', () => {
  test('.html opens as source, then Open Preview switches to the html preview', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-html-'))
    const htmlFile = join(tmpDir, 'index.html')
    writeFileSync(htmlFile, HTML_DOC)
    writeFileSync(join(tmpDir, 'style.css'), 'h1{color:red}')
    const htmlFsPath = htmlFile.replace(/\\/g, '/')

    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), htmlFsPath)

    // Default open is the text editor.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('file')

    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.html.openPreview'))

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('html.preview')

    // The preview host actually mounted.
    await expect(page.getByTestId('html-preview')).toBeVisible()
  })
})
