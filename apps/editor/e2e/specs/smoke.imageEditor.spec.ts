/*---------------------------------------------------------------------------------------------
 *  Image editor smoke (P1).
 *
 *  验证图片文件默认经 EditorResolverService 分发到图片编辑器（typeId='image'），
 *  并可通过 "Reopen With..." 回退到文本编辑器（typeId='file'）。
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

// A minimal valid 1x1 transparent PNG.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test.describe('@p1 image editor', () => {
  test('opens a .png as the image editor', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-image-'))
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

    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-image-reopen-'))
    const pngFile = join(tmpDir, 'pixel.png')
    writeFileSync(pngFile, Buffer.from(PNG_1X1_BASE64, 'base64'))
    const pngFsPath = pngFile.replace(/\\/g, '/')

    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), pngFsPath)

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('image')

    await page.evaluate((fsPath) => {
      const uri = { scheme: 'file', path: fsPath, authority: '', query: '', fragment: '' }
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
})
