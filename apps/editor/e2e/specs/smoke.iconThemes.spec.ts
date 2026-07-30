/*---------------------------------------------------------------------------------------------
 *  S2 — 文件/产品图标主题机制冒烟（P0）。
 *
 *  对照 VSCode 的 contributes.iconThemes / productIconThemes 链路：
 *  内置 theme-defaults 扩展注册 universe-material（VSCode JSON 格式）→ 缺省
 *  激活，FileIcon 走样式表协议类（.ts-ext-file-icon…）+ body.show-file-icons
 *  门闸；workbench.iconTheme=null（None）回退内联 Material SVG；picker 导航
 *  即预览、Escape 回滚。产品图标主题默认 Default（codicon，无样式表覆盖）。
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/coreThemesColdApp.js'

test.use({
  workspaceSeeder: {
    seed(dir: string) {
      mkdirSync(join(dir, 'src'))
      writeFileSync(join(dir, 'sample.ts'), 'export const x = 1\n')
      writeFileSync(join(dir, 'README.md'), '# hello\n')
    },
  },
})

function fileIconThemeId(page: Page): Promise<string> {
  return page.evaluate(() => window.__E2E__!.getFileIconThemeId())
}

function showFileIconsGate(page: Page): Promise<boolean> {
  return page.evaluate(() => document.body.classList.contains('show-file-icons'))
}

/** The FileIcon span inside the explorer row whose label contains `name`. */
function explorerIcon(page: Page, name: string) {
  return page
    .locator('[role="tree"] [role="treeitem"]', { hasText: name })
    .locator('span[data-file-icon]')
    .first()
}

test.describe('@p0 icon themes', () => {
  test('universe-material activates by default: protocol classes + show-file-icons gate', async ({
    page,
  }) => {
    await expect
      .poll(() => fileIconThemeId(page), { timeout: 20000 })
      .toContain('universe-material')
    await expect.poll(() => showFileIconsGate(page)).toBe(true)

    // sample.ts renders through the stylesheet protocol classes, not inline SVG.
    await expect
      .poll(() => explorerIcon(page, 'sample.ts').getAttribute('class'), { timeout: 15000 })
      .toContain('ts-ext-file-icon')
    await expect
      .poll(() => explorerIcon(page, 'src').getAttribute('class'), { timeout: 15000 })
      .toContain('folder-icon')
    // README.md resolves through the extension + language fallbacks.
    await expect
      .poll(() => explorerIcon(page, 'README.md').getAttribute('class'), { timeout: 15000 })
      .toContain('md-ext-file-icon')
  })

  test('workbench.iconTheme=null (None) falls back to inline Material SVGs', async ({ page }) => {
    await expect
      .poll(() => fileIconThemeId(page), { timeout: 20000 })
      .toContain('universe-material')

    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.iconTheme', null)
    })
    await expect.poll(() => fileIconThemeId(page), { timeout: 15000 }).toBe('')
    await expect.poll(() => showFileIconsGate(page)).toBe(false)

    // Programmatic fallback: the built-in inline-SVG path tags mi-<name> ids.
    await expect
      .poll(() => explorerIcon(page, 'sample.ts').getAttribute('data-file-icon'), {
        timeout: 15000,
      })
      .toBe('mi-typescript')

    // Restoring the setting brings the stylesheet theme back.
    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.iconTheme', 'universe-material')
    })
    await expect
      .poll(() => fileIconThemeId(page), { timeout: 15000 })
      .toContain('universe-material')
    await expect
      .poll(() => explorerIcon(page, 'sample.ts').getAttribute('class'), { timeout: 15000 })
      .toContain('ts-ext-file-icon')
  })

  test('file icon theme picker previews on navigation and rolls back on Escape', async ({
    page,
    workbench,
  }) => {
    // Wait for the deferred initial application (extension translation lands in
    // the Eventually phase) before driving the picker.
    await expect
      .poll(() => fileIconThemeId(page), { timeout: 20000 })
      .toContain('universe-material')
    const originalId = await fileIconThemeId(page)

    // selectIconTheme awaits the pick — fire-and-forget so the test drives the UI.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.selectIconTheme')
    })
    await workbench.quickInput.waitForVisible()

    // Filtering to "None" activates it, which previews immediately.
    await workbench.quickInput.input.fill('None')
    await expect.poll(() => fileIconThemeId(page), { timeout: 15000 }).toBe('')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => fileIconThemeId(page), { timeout: 15000 }).toBe(originalId)
  })

  test('file icon theme picker accept persists the selection', async ({ page, workbench }) => {
    await expect
      .poll(() => fileIconThemeId(page), { timeout: 20000 })
      .toContain('universe-material')
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.selectIconTheme')
    })
    await workbench.quickInput.waitForVisible()
    await workbench.quickInput.input.fill('None')
    // Wait until the preview applied — guarantees the None item is active.
    await expect.poll(() => fileIconThemeId(page), { timeout: 15000 }).toBe('')
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect.poll(() => fileIconThemeId(page), { timeout: 15000 }).toBe('')
    await expect.poll(() => showFileIconsGate(page)).toBe(false)
  })

  test('product icon theme defaults to Default (built-in codicons, no stylesheet)', async ({
    page,
    workbench,
  }) => {
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getProductIconThemeId()), {
        timeout: 20000,
      })
      .toBe('')

    // The picker lists the Default entry and closes cleanly without switching.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.selectProductIconTheme')
    })
    await workbench.quickInput.waitForVisible()
    await workbench.quickInput.input.fill('Default')
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getProductIconThemeId())).toBe('')
  })
})
