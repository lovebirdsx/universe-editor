/*---------------------------------------------------------------------------------------------
 *  Markdown 预览 <a id> 锚点跳转落点回归 (@regression)。
 *
 *  复现 bug：预览中点击 #frag 链接跳转到正文里的空锚点 <a id="x"></a> 时，
 *  落点偏下约一行 —— 锚点所在行的文字被顶到视口上方不可见。
 *
 *  根因：.mdAnchor 是零占位 inline-block（overflow:hidden + height:0 +
 *  vertical-align:baseline），按 CSS 规范其基线是 bottom margin edge，元素
 *  上边恰好落在所在行的文字基线上；scrollIntoView({block:'start'}) 对齐的是
 *  元素上边（= 基线），基线以上的字形被裁到视口上方。修复是把 vertical-align
 *  改为 text-top，让元素上边对齐文字顶部。
 *
 *  几何断言依赖真实布局，happy-dom 单测不可测 —— 必须在真实 Electron 里跑。
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

const PREVIEW = '[data-testid="markdown-preview"]'
const ANCHOR_ID = 'jump-target'

function writeAnchorMarkdown(): string {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-mdanchor-'))
  const file = join(dir, 'anchor.md')
  const filler = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `filler ${tag} paragraph ${i}\n`).join('\n')
  const content =
    `# Anchor Doc\n\n[跳到目标](#${ANCHOR_ID})\n\n` +
    `${filler(50, 'before')}\n` +
    `目标段落文字 <a id="${ANCHOR_ID}"></a>\n\n` +
    `${filler(30, 'after')}\n`
  writeFileSync(file, content)
  return file.replace(/\\/g, '/')
}

test.describe('@p1 markdown preview — #frag jump to <a id> anchor', () => {
  test('anchor line stays inside the viewport after jumping @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const mdFsPath = writeAnchorMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    // 点击预览顶部的 # 链接，触发 scrollIntoView({block:'start', behavior:'smooth'})。
    const link = page.locator(`${PREVIEW} a`, { hasText: '跳到目标' })
    await link.waitFor()
    await link.click()

    // 等平滑滚动收敛：连续两次采样 scrollTop 相等即稳定，避免滚动途中的
    // 瞬态几何造成假绿/假红。
    await expect
      .poll(
        async () => {
          const a = await page.evaluate(
            (sel) => (document.querySelector(sel) as HTMLElement).scrollTop,
            PREVIEW,
          )
          await page.waitForTimeout(120)
          const b = await page.evaluate(
            (sel) => (document.querySelector(sel) as HTMLElement).scrollTop,
            PREVIEW,
          )
          return a > 0 && a === b
        },
        { timeout: 5000 },
      )
      .toBe(true)

    // 核心断言：锚点所在段落未被顶出视口（修复前段落顶部在容器上方 ~11px）。
    const { pTop, cTop } = await page.evaluate(
      ([previewSel, anchorId]) => {
        const anchor = document.querySelector(`[data-anchor="${anchorId}"]`)!
        const p = anchor.closest('p')!.getBoundingClientRect()
        const c = (document.querySelector(previewSel) as HTMLElement).getBoundingClientRect()
        return { pTop: p.top, cTop: c.top }
      },
      [PREVIEW, ANCHOR_ID] as const,
    )
    expect(pTop).toBeGreaterThanOrEqual(cTop - 1)
  })
})
