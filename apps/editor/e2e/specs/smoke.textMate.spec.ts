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
// JSON: key (`support.type.property-name`) and string value (`string`) resolve
// to distinct colors — a mismatch between the textmate colorMap and the
// `.mtkN` stylesheet shows up here immediately.
const DARK_JSON_KEY = 'rgb(156, 220, 254)' // #9CDCFE
const DARK_JSON_STRING = 'rgb(206, 145, 120)' // #CE9178

function seedFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'universe-textmate-'))
  const filePath = join(dir, name)
  writeFileSync(filePath, content, 'utf8')
  return filePath
}

function seedTsFile(content: string): string {
  return seedFile('sample.ts', content)
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

/** Same as tokenColor but matches by substring (JSON spans may keep quotes).
 *  Leaf spans only: the view-line wrapper span contains the whole line text
 *  and would otherwise win the DOM-order scan with its inherited color. */
function tokenColorContaining(page: Page, fragment: string): Promise<string | undefined> {
  return page.evaluate((t) => {
    for (const span of document.querySelectorAll('.monaco-editor .view-line span')) {
      if (
        span.childElementCount === 0 &&
        span.textContent !== null &&
        span.textContent.includes(t)
      ) {
        return getComputedStyle(span).color
      }
    }
    return undefined
  }, fragment)
}

function textMateStyleRules(page: Page): Promise<string> {
  // Single source of truth: monaco's StandaloneThemeService stylesheet, whose
  // color map mirrors the textmate one via defineTheme's encodedTokensColors.
  return page.evaluate(() => document.querySelector('style.monaco-colors')?.textContent ?? '')
}

/** Poll until the TextMate grammar factory owns tokenization for `languageId`.
 *  Every color assertion implicitly depends on this takeover (pre-takeover the
 *  Monarch renderer merges neighbouring same-class tokens into one span, so
 *  exact-text probes can never match) — gate on it explicitly so a slow or lost
 *  takeover fails here, loudly, instead of as an opaque undefined color. */
async function waitForTextMateTakeover(page: Page, languageId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .evaluate((lang) => window.__E2E__!.getTokenizationSupportInfo(lang), languageId)
          .then((info) => info?.constructorName),
      { timeout: 30000 },
    )
    .toBe('TokenizationSupportWithLineLimit')
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
    // First test on a fresh/reset worker pays the extension-host boot: a 30s
    // takeover poll needs headroom over the 30s test ceiling (whole file: every
    // test here opens with a 30s first poll, so they all get the slow budget).
    test.slow()
    const filePath = seedTsFile('const answer: number = 42\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    // The TextMate factory registers after monaco loads and must replace the
    // Monarch support (registry change re-tokenizes the open model).
    await waitForTextMateTakeover(page, 'typescript')

    // The theme bridge injects the .mtkN classifier stylesheet.
    await expect.poll(() => textMateStyleRules(page), { timeout: 15000 }).toContain('.mtk')

    // The keyword token is colored by the theme's TextMate rules, not the
    // plain editor foreground.
    await expect.poll(() => tokenColor(page, 'const'), { timeout: 15000 }).toBe(DARK_KEYWORD)
  })

  test('token colors follow color theme switches', async ({ page, workbench }) => {
    test.slow()
    const filePath = seedTsFile('const answer: number = 42\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await waitForTextMateTakeover(page, 'typescript')
    await expect.poll(() => tokenColor(page, 'const'), { timeout: 15000 }).toBe(DARK_KEYWORD)

    await page.evaluate(() => {
      window.__E2E__!.updateConfigValue('workbench.colorTheme', 'Universe Light')
    })
    await expect.poll(() => tokenColor(page, 'const'), { timeout: 15000 }).toBe(LIGHT_KEYWORD)
  })

  test('json keys and string values render their distinct theme colors @regression', async ({
    page,
    workbench,
  }) => {
    test.slow()
    // Guards the unified color table: with two independent color maps (monaco
    // TokenTheme vs textmate) the `.mtkN` stylesheet that happened to load last
    // won by DOM order, and JSON keys lost their #9CDCFE — reliably in dev,
    // workspace-dependent in release builds.
    const filePath = seedFile('sample.json', '{\n  "name": "universe",\n  "count": 42\n}\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    await expect
      .poll(() => tokenColorContaining(page, 'name'), { timeout: 30000 })
      .toBe(DARK_JSON_KEY)
    await expect
      .poll(() => tokenColorContaining(page, 'universe'), { timeout: 15000 })
      .toBe(DARK_JSON_STRING)
  })

  test('over-long lines degrade to null tokenization without blocking render', async ({
    page,
    workbench,
  }) => {
    test.slow()
    // 25k chars on one line exceeds the 20k limit: nullTokenizeEncoded keeps
    // the line a single default-foreground token instead of stalling the
    // tokenizer on pathological regex backtracking.
    const filePath = seedTsFile(`const s = '${'a'.repeat(25_000)}'\nconst after = 1\n`)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    // The `after` probe below only matches once TextMate owns tokenization
    // (Monarch merges ` after ` with its neighbours into one span) — gate the
    // takeover first so a slow extension-host boot fails with a clear signal.
    await waitForTextMateTakeover(page, 'typescript')

    // The editor renders and the next (short) line still tokenizes normally.
    await expect.poll(() => tokenColor(page, 'after'), { timeout: 15000 }).toBeDefined()
    expect(await page.evaluate(() => window.__E2E__!.getActiveEditorUri())).toContain('sample.ts')
  })
})
