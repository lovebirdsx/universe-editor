/*---------------------------------------------------------------------------------------------
 *  TextMate token 着色冒烟（P0）。
 *
 *  对照 VSCode 的 TextMateTokenizationFeature 链路：打开 .ts 文件后
 *  textmate-grammars 扩展的 grammar 工厂应顶替 Monarch 接管 tokenization
 *  （TokenizationRegistry 后注册者胜）；token 颜色来自颜色主题的 tokenColors
 *  经 colorMap + .mtkN 样式表呈现，且随主题切换变化；超长行降级为
 *  nullTokenize，不阻塞渲染。
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../fixtures/coreTextMateApp.js'

// 'const' is `storage.type.ts` in the TypeScript grammar; both built-in
// themes map storage.type to the same value as keyword.
const DARK_KEYWORD = 'rgb(86, 156, 214)' // #569CD6 (Universe Dark)
const LIGHT_KEYWORD = 'rgb(0, 0, 255)' // #0000FF (Universe Light)

function seedTsFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'universe-textmate-'))
  const filePath = join(dir, 'sample.ts')
  writeFileSync(filePath, content, 'utf8')
  return filePath
}

/** Computed color of the first view-line span whose exact text is `token`. */
function tokenColor(page: Page, token: string): Promise<string | undefined> {
  return page.evaluate((t) => {
    for (const span of document.querySelectorAll('.monaco-editor .view-line span')) {
      if (span.textContent === t) {
        return getComputedStyle(span).color
      }
    }
    return undefined
  }, token)
}

function textMateStyleRules(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('style.contributedTextMateTokens')?.textContent ?? '',
  )
}

test.describe('@p0 textmate', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorTheme', 'Universe Dark')
    })
  })

  test('grammar factory takes over typescript tokenization and colors from the theme', async ({
    page,
    workbench,
  }) => {
    const filePath = seedTsFile('const answer: number = 42\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    // The TextMate factory registers after monaco loads and must replace the
    // Monarch support (registry change re-tokenizes the open model).
    await expect
      .poll(
        () =>
          page
            .evaluate(() => window.__E2E__!.getTokenizationSupportInfo('typescript'))
            .then((info) => info?.constructorName),
        { timeout: 30000 },
      )
      .toBe('TokenizationSupportWithLineLimit')

    // The theme bridge injects the .mtkN classifier stylesheet.
    await expect.poll(() => textMateStyleRules(page), { timeout: 15000 }).toContain('.mtk')

    // The keyword token is colored by the theme's TextMate rules, not the
    // plain editor foreground.
    await expect.poll(() => tokenColor(page, 'const'), { timeout: 15000 }).toBe(DARK_KEYWORD)
  })

  test('token colors follow color theme switches', async ({ page, workbench }) => {
    const filePath = seedTsFile('const answer: number = 42\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await expect.poll(() => tokenColor(page, 'const'), { timeout: 30000 }).toBe(DARK_KEYWORD)

    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorTheme', 'Universe Light')
    })
    await expect.poll(() => tokenColor(page, 'const'), { timeout: 15000 }).toBe(LIGHT_KEYWORD)
  })

  test('over-long lines degrade to null tokenization without blocking render', async ({
    page,
    workbench,
  }) => {
    // 25k chars on one line exceeds the 20k limit: nullTokenizeEncoded keeps
    // the line a single default-foreground token instead of stalling the
    // tokenizer on pathological regex backtracking.
    const filePath = seedTsFile(`const s = '${'a'.repeat(25_000)}'\nconst after = 1\n`)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    // The editor renders and the next (short) line still tokenizes normally.
    await expect.poll(() => tokenColor(page, 'after'), { timeout: 30000 }).toBeDefined()
    expect(await page.evaluate(() => window.__E2E__!.getActiveEditorUri())).toContain('sample.ts')
  })
})
