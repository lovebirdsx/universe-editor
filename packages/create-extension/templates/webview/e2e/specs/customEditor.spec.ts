import { test, expect } from '../fixtures/app.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.describe('@p1 __name__', () => {
  test('opens a .__name__ file in its read-only custom editor', async ({ page, workbench }) => {
    test.slow()
    const dir = mkdtempSync(join(tmpdir(), 'ues-__name__-'))
    const filePath = join(dir, 'sample.__name__')
    writeFileSync(filePath, 'preview me', 'utf8')

    await workbench.waitForRestored()

    // Open through the editor resolver; the custom editor contributes for
    // *.__name__, so the active editor must resolve to a customEditor.
    await expect
      .poll(
        async () => {
          await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
          return page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())
        },
        { timeout: 15000 },
      )
      .toBe('customEditor')

    // The preview webview rendered the static template: title + file name.
    const frame = page.frameLocator('[data-testid="webview-frame"]')
    await expect(frame.locator('h1')).toHaveText('__displayName__', { timeout: 15000 })
    await expect(frame.locator('body')).toContainText('sample.__name__', { timeout: 15000 })
  })
})
