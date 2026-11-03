/*---------------------------------------------------------------------------------------------
 *  Image editor smoke (P1).
 *
 *  验证图片文件默认经 EditorResolverService 分发到图片编辑器（typeId='image'），
 *  并可通过 "Reopen With..." 回退到文本编辑器（typeId='file'）。
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

// A minimal valid 1x1 transparent PNG.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** 最新 session 的 main console 日志（Error 级条目即时 flush）。 */
function readNewestConsoleLog(userData: string): string {
  let sessions: string[]
  try {
    sessions = readdirSync(join(userData, 'logs')).sort()
  } catch {
    return ''
  }
  const newest = sessions.at(-1)
  if (!newest) return ''
  try {
    return readFileSync(join(userData, 'logs', newest, 'console.log'), 'utf8')
  } catch {
    return ''
  }
}

test.describe('@p1 image editor', () => {
  test('opens a .png as the image editor', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const tmpDir = mkTempDir('universe-editor-e2e-image-')
    const pngFile = join(tmpDir, 'pixel.png')
    writeFileSync(pngFile, Buffer.from(PNG_1X1_BASE64, 'base64'))
    const pngFsPath = pngFile.replace(/\\/g, '/')

    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), pngFsPath)

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('image')

    // The image view actually mounted.
    await expect(page.getByTestId('image-editor')).toBeVisible()
  })

  test('"Reopen With..." switches a .png from image to file', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const tmpDir = mkTempDir('universe-editor-e2e-image-reopen-')
    const pngFile = join(tmpDir, 'pixel.png')
    writeFileSync(pngFile, Buffer.from(PNG_1X1_BASE64, 'base64'))
    const pngFsPath = pngFile.replace(/\\/g, '/')

    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), pngFsPath)

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('image')

    await page.evaluate((fsPath) => {
      // Canonical UriComponents: a bare 'C:/…' path stringifies to parse-unstable file://C:/….
      const forward = fsPath.replace(/\\/g, '/')
      const uri = {
        scheme: 'file',
        path: forward.startsWith('/') ? forward : '/' + forward,
        authority: '',
        query: '',
        fragment: '',
      }
      void window.__E2E__!.runCommand('workbench.action.reopenWith', { resource: uri })
    }, pngFsPath)

    await workbench.quickInput.waitForVisible()
    await page.keyboard.type('File')
    const fileOption = page.getByRole('option', { name: 'File Editor' })
    await expect(fileOption).toBeVisible()
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('file')
  })

  test('a missing image shows the failure message without logging ERR_FILE_NOT_FOUND', async ({
    electronApp,
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const before = readNewestConsoleLog(userData)

    // 不创建文件：EditorResolverService 只按扩展名路由，仍会打开图片编辑器。
    const tmpDir = mkTempDir('universe-editor-e2e-image-missing-')
    const missingFsPath = join(tmpDir, 'missing.png').replace(/\\/g, '/')

    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), missingFsPath)

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('image')
    await expect(page.getByText('Cannot display this image.')).toBeVisible()
    // stat 失败后不渲染 <img>，因此不会发出 ue-file 请求。
    await expect(page.locator('[data-testid="image-editor"] img')).toHaveCount(0)

    // Error 级日志立即 flush；给修复前的回归留出落盘时间再读增量。
    await page.waitForTimeout(500)
    const appended = readNewestConsoleLog(userData).slice(before.length)
    expect(appended).not.toContain('ERR_FILE_NOT_FOUND')
  })
})
