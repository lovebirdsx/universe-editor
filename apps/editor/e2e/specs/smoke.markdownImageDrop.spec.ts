/*---------------------------------------------------------------------------------------------
 *  Markdown 预览图片拖拽回归 (@regression)。
 *
 *  回归：把预览里的图片拖到编辑器标签栏，打开了一个"空编辑器"（图片区只剩
 *  "Cannot display this image."），输出面板报 net::ERR_FILE_NOT_FOUND。
 *  根因：预览 <img> 的 src 是 universe-app://root/_resource_/<编码后的绝对路径>
 *  （本仓的 asWebviewUri，见 workbench/markdown/resourceUri.ts），预览图片没有自定义
 *  拖拽源，Chromium 原生图片拖拽把这个 transport URL 原样写进 text/uri-list（且不带
 *  我们的私有镜像）。drop 收口 readDroppedResources 直接 URI.parse 当成资源身份 →
 *  解析器按 uri.path 命中图片扩展名 → ImageEditor 把 `_resource_/F:/…` 当本机路径拼出
 *  ue-file URL → net.fetch('file:///_resource_/F:/…') 报 ERR_FILE_NOT_FOUND。
 *  修复：readDroppedResources 把资源 URL 还原成它指向的 file: URI。
 *
 *  这里刻意用预览真实渲染出的 src（而不是手拼 URL）作为拖拽载荷，并把断言放在
 *  "打开的必须是那个图片文件"上 —— 载荷形态变了本用例仍会失败。
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const PREVIEW = '[data-testid="markdown-preview"]'

const SVG_1X1 = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n'

function writePreviewDoc(): { dir: string; mdFsPath: string } {
  const dir = mkTempDir('universe-editor-e2e-mddrop-')
  writeFileSync(join(dir, 'img.svg'), SVG_1X1)
  const md = join(dir, 'foo.md')
  writeFileSync(md, '# Foo\n\n![p](./img.svg)\n')
  return { dir, mdFsPath: md.replace(/\\/g, '/') }
}

/** 预览里那张图真实渲染出的 src（= 拉它时 Chromium 写进 drag payload 的字符串）。 */
async function previewImageSrc(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(
    (sel) => document.querySelector(`${sel} img`)?.getAttribute('src') ?? '',
    PREVIEW,
  )
}

/** 合成原生图片拖拽：只带标准 text/uri-list，不写应用私有镜像。 */
async function dropNativeImageOnTabBar(
  page: import('@playwright/test').Page,
  uri: string,
): Promise<void> {
  await page.evaluate((u) => {
    const bar = document.querySelector<HTMLElement>('[data-testid="editor-group-tabbar"]')
    if (!bar) throw new Error('editor group tab bar missing')
    const dt = new DataTransfer()
    dt.setData('text/uri-list', u as string)
    const fire = (type: string): void => {
      const r = bar.getBoundingClientRect()
      bar.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: r.right - 4,
          clientY: r.top + r.height / 2,
          dataTransfer: dt,
        }),
      )
    }
    fire('dragenter')
    fire('dragover')
    fire('drop')
  }, uri)
}

test.describe('markdown preview image drop', () => {
  test('dragging a preview image onto the tab bar opens that image @regression', async ({
    page,
    workbench,
  }) => {
    const { mdFsPath } = writePreviewDoc()

    await workbench.waitForRestored()
    await page.evaluate((p) => window.__E2E__!.openFileUri(p, { pinned: true }), mdFsPath)
    await expect.poll(() => workbench.getActiveEditorUri(), { timeout: 5000 }).toContain('foo.md')

    await workbench.runCommand('workbench.action.markdown.openPreview')
    // 生产侧契约：预览图片的 src 走 universe-app 资源 URL（不是 file:），
    // 这正是拖拽载荷里那个地址的来源。
    await expect
      .poll(() => previewImageSrc(page), { timeout: 5000 })
      .toMatch(/^universe-app:\/\/root\/_resource_\//)
    const src = await previewImageSrc(page)
    expect(src.endsWith('img.svg')).toBe(true)

    await dropNativeImageOnTabBar(page, src)

    // 打开的必须是图片文件本身：图片编辑器 + file: 资源（修复前是空 tab，
    // 资源是 universe-app:，图片取字节时 ERR_FILE_NOT_FOUND）。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('image')
    const uri = await page.evaluate(() => window.__E2E__!.getActiveEditorUri())
    expect(uri).toContain('img.svg')
    expect(uri).not.toContain('_resource_')

    // 字节真的加载出来了 —— 图片加载失败时 ImageEditor 只渲染一句提示。
    await expect(page.getByTestId('image-editor')).toHaveCount(1)
    await expect(page.getByText('Cannot display this image.')).toHaveCount(0)
  })
})
