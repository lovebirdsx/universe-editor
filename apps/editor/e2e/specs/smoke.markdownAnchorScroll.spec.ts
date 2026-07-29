/*---------------------------------------------------------------------------------------------
 *  Markdown 预览锚点跳转落点回归 (@regression)。
 *
 *  回归 1：预览中点击 #frag 链接跳转到正文里的空锚点 <a id="x"></a> 时，
 *  落点偏下约一行 —— 锚点所在行的文字被顶到视口上方不可见。
 *  根因：.mdAnchor 是零占位 inline-block（overflow:hidden + height:0 +
 *  vertical-align:baseline），按 CSS 规范其基线是 bottom margin edge，元素
 *  上边恰好落在所在行的文字基线上；scrollIntoView({block:'start'}) 对齐的是
 *  元素上边（= 基线），基线以上的字形被裁到视口上方。修复是把 vertical-align
 *  改为 text-top，让元素上边对齐文字顶部。
 *
 *  回归 2：跨文件锚点跳转后回退，再点其它锚点链接，落点仍是上一次的位置。
 *  根因：b.md 预览重挂载时 useMarkdownPreviewScrollRestore 恢复 saved
 *  scrollTop（600ms ResizeObserver 窗口反复钉住），压过新请求的锚点。修复是
 *  锚点作为 one-shot 并入 MarkdownPreviewViewStateCache，由 restore 效应统一
 *  决策（anchor > revealLine > saved scrollTop）。
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

function writeCrossFileDocs(): { a: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-mdxfile-'))
  const filler = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `filler ${tag} paragraph ${i}\n`).join('\n')
  const a = join(dir, 'a.md')
  const b = join(dir, 'b.md')
  writeFileSync(a, `# A Doc\n\n[go-two](./b.md#section-two)\n\n[go-six](./b.md#section-six)\n`)
  writeFileSync(
    b,
    `# B Doc\n\n${filler(20, 'top')}\n## section two\n\n${filler(30, 'mid')}\n## section six\n\n${filler(20, 'tail')}\n`,
  )
  return { a: a.replace(/\\/g, '/') }
}

/** 连续两次采样 scrollTop 相等即认为滚动已收敛，避开平滑滚动/restore 窗口的瞬态。 */
async function waitForScrollSettled(page: import('@playwright/test').Page): Promise<void> {
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

    // 等平滑滚动收敛，避免滚动途中的瞬态几何造成假绿/假红。
    await waitForScrollSettled(page)

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

test.describe('@p1 markdown preview — cross-file anchor after back-navigation', () => {
  // 复现 bug：a.md 预览点击 b.md#section-six 跳到 six；goBack 回到 a 后再点击
  // b.md#section-two，落点仍是 six —— b 预览重挂载时恢复的 saved scrollTop
  //（ResizeObserver 600ms 窗口反复钉住）压过了新请求的锚点。
  test('a second cross-file link lands on its own anchor, not the previous one @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const { a } = writeCrossFileDocs()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), a)
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    // 第一跳：a 预览 → b.md#section-six。
    const goSix = page.locator(`${PREVIEW} a`, { hasText: 'go-six' })
    await goSix.waitFor()
    await goSix.click()
    await page.locator('[data-anchor="section-six"]').waitFor()
    await waitForScrollSettled(page)

    // 回退到 a 的预览（in-place 替换的导航轨迹，Alt+Left 同源命令）。
    await workbench.runCommand('workbench.action.goBack')
    const goTwo = page.locator(`${PREVIEW} a`, { hasText: 'go-two' })
    await goTwo.waitFor()

    // 第二跳：必须落在 section-two，而不是上次的 section-six 位置。
    await goTwo.click()
    await page.locator('[data-anchor="section-two"]').waitFor()
    await waitForScrollSettled(page)

    const { twoTop, sixTop, cTop } = await page.evaluate((previewSel) => {
      const two = document.querySelector('[data-anchor="section-two"]')!.getBoundingClientRect()
      const six = document.querySelector('[data-anchor="section-six"]')!.getBoundingClientRect()
      const c = (document.querySelector(previewSel) as HTMLElement).getBoundingClientRect()
      return { twoTop: two.top, sixTop: six.top, cTop: c.top }
    }, PREVIEW)
    // section-two 顶到视口顶部附近；section-six 远在视口下方（说明没有落错）。
    expect(Math.abs(twoTop - cTop)).toBeLessThanOrEqual(40)
    expect(sixTop - cTop).toBeGreaterThan(200)
  })
})
