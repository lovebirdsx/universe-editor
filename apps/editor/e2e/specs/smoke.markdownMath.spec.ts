/*---------------------------------------------------------------------------------------------
 *  Markdown 预览 LaTeX 数学公式冒烟 (@p1)。
 *
 *  覆盖三条渲染路径（行内 `$…$`、块级 `$$…$$`、```math 围栏）、货币符号不被
 *  误判、KaTeX 字体真实加载，以及 `markdown.math.enabled` 关闭后回退为原文。
 *  字体与真实 DOM 渲染在 happy-dom 中不可验证，故走真实 Electron。
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const PREVIEW = '[data-testid="markdown-preview"]'
const MATH_ENABLED_KEY = 'markdown.math.enabled'

function writeMathMarkdown(): string {
  const dir = mkTempDir('universe-editor-e2e-mdmath-')
  const file = join(dir, 'math.md')
  const content = [
    '# Math Doc',
    '',
    '行内公式 $x^2 + y^2$ 与货币 $5 and $6。',
    '',
    '$$',
    '\\frac{a}{b}',
    '$$',
    '',
    '```math',
    '\\sum_{i=1}^{n} i',
    '```',
    '',
  ].join('\n')
  writeFileSync(file, content)
  return file.replace(/\\/g, '/')
}

test.describe('@p1 markdown preview — LaTeX math', () => {
  test('renders $…$, $$…$$ and ```math, then falls back when disabled @p1', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const mdFsPath = writeMathMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    // 三条路径各渲染一次；KaTeX 懒加载 chunk 解析完成前先显示原文。
    const katex = page.locator(`${PREVIEW} .katex`)
    await expect.poll(() => katex.count(), { timeout: 5000 }).toBe(3)
    await expect(page.locator(`${PREVIEW} .katex-display`)).toHaveCount(2)
    await expect(page.locator(`${PREVIEW} .katex-error`)).toHaveCount(0)

    // 货币符号必须保持普通文本，不能被吞成公式。
    await expect(page.locator(PREVIEW)).toContainText('$5 and $6')

    // 字体真实可用：KaTeX CSS 的 @font-face 通过 file 协议加载成功。
    // `document.fonts.check()` alone can report true for a font that was never
    // loaded, so require at least one loaded KaTeX FontFace.
    await expect
      .poll(
        () =>
          page.evaluate(async (sel) => {
            await document.fonts.ready
            const el = document.querySelector(`${sel} .katex`)
            const family = el === null ? '' : getComputedStyle(el).fontFamily
            const loadedFaces = Array.from(document.fonts).filter(
              (face) => face.family.includes('KaTeX') && face.status === 'loaded',
            ).length
            return { familyOk: family.includes('KaTeX_Main'), loaded: loadedFaces > 0 }
          }, PREVIEW),
        { timeout: 5000 },
      )
      .toEqual({ familyOk: true, loaded: true })

    // 关闭设置后同一预览实时回退为原文（不清空已加载的公式 DOM 之外的状态）。
    await page.evaluate(() => window.__E2E__!.whenUserSettingsInitialized())
    try {
      await page.evaluate((key) => window.__E2E__!.updateConfigValue(key, false), MATH_ENABLED_KEY)
      await expect.poll(() => katex.count(), { timeout: 5000 }).toBe(0)
      await expect(page.locator(PREVIEW)).toContainText('$$')
      await expect(page.locator(PREVIEW)).toContainText('\\frac{a}{b}')
    } finally {
      await page.evaluate((key) => window.__E2E__!.updateConfigValue(key, true), MATH_ENABLED_KEY)
    }
    await expect.poll(() => katex.count(), { timeout: 5000 }).toBe(3)
  })
})
