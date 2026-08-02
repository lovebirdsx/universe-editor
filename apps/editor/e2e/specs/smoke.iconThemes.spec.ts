/*---------------------------------------------------------------------------------------------
 *  S2 — 文件/产品图标主题机制冒烟（P0）。
 *
 *  对照 VSCode 的 workbench.iconTheme / productIconTheme 语义：文件图标主题
 *  默认 Universe Material（workbench.iconTheme=null 的内置项）——FileIcon 走
 *  内联 Material SVG（data-file-icon="mi-<name>"），无 body.show-file-icons
 *  门闸、无 contributed 样式表；picker 列出 Universe Material 条目，Enter 确认
 *  后保持默认。JSON 图标主题机制
 *  （contributes.iconThemes → 协议类 + 门闸）由单测覆盖（workbenchThemeService /
 *  fileIconThemeData / generateFileIconThemeCss）。产品图标主题默认 Default
 *  （codicon，无样式表覆盖）。
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/electronApp.js'

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
  test('Universe Material is the default: inline Material SVGs, no stylesheet gate', async ({
    page,
  }) => {
    await expect.poll(() => fileIconThemeId(page), { timeout: 20000 }).toBe('')
    await expect.poll(() => showFileIconsGate(page)).toBe(false)

    // Files/folders render through the inline-SVG path (mi-<name> ids), covering
    // extension, folder-name and file-name resolution.
    await expect
      .poll(() => explorerIcon(page, 'sample.ts').getAttribute('data-file-icon'), {
        timeout: 15000,
      })
      .toBe('mi-typescript')
    await expect
      .poll(() => explorerIcon(page, 'src').getAttribute('data-file-icon'), { timeout: 15000 })
      .toBe('mi-folder-src')
    await expect
      .poll(() => explorerIcon(page, 'README.md').getAttribute('data-file-icon'), {
        timeout: 15000,
      })
      .toBe('mi-readme')
  })

  test('file icon theme picker lists Universe Material and accept keeps it active', async ({
    page,
    workbench,
  }) => {
    await expect.poll(() => fileIconThemeId(page), { timeout: 20000 }).toBe('')

    // selectIconTheme awaits the pick — fire-and-forget so the test drives the UI.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.selectIconTheme')
    })
    await workbench.quickInput.waitForVisible()
    await workbench.quickInput.input.fill('Universe Material')
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
