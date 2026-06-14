/*---------------------------------------------------------------------------------------------
 *  Mermaid preview tab-switch regression (@p1).
 *
 *  复现两个 bug：
 *    1. 预览含 mermaid 的 markdown，首次渲染正确；切到另一个 editor 再切回后，
 *       mermaid 图（尤其是 pie）变空 —— SVG 仍在但内容（扇区/连线）丢失。
 *    2. 切回预览后，滚动位置被重置到顶部。
 *
 *  根因：EditorGroupView.renderContent() 只渲染 activeEditor，切走时整棵
 *  MarkdownPreviewEditor 子树被真正 unmount，切回时全新 mount。真实浏览器里
 *  detach 会复位 scrollTop（滚动丢失）；而 dev 的 <StrictMode> 双调用 effect，
 *  让多张图以相同 render id 并发渲染、互删 mermaid 的临时测量节点而产出空图。
 *  happy-dom 单测看不出来 —— 必须在真实 Electron 里跑。
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

// 轻量、确定的 fixture：几张图（含对竞态最敏感的 pie）+ 大量文本填充使其可滚动。
// 数量小 → 串行渲染快 → 能在 restore 窗口内稳定，避免重型真实文档在 CI 高负载下
// 因渲染过慢 + 浏览器 scroll-anchoring 造成的位置漂移。
function writeMermaidMarkdown(): string {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-mermaid-'))
  const file = join(dir, 'diagram.md')
  const filler = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nparagraph ${i}\n`).join(
    '\n',
  )
  const pie = '```mermaid\npie title Pets\n  "Dogs" : 386\n  "Cats" : 85\n  "Rats" : 15\n```'
  const flow = '```mermaid\ngraph LR\n  A[开始] --> B{判断} --> C[结束]\n```'
  const content = `# Mermaid\n\n${pie}\n\n${flow}\n\n${pie}\n\n${filler}\n`
  writeFileSync(file, content)
  return file.replace(/\\/g, '/')
}

const PREVIEW = '[data-testid="markdown-preview"]'
const DIAGRAM = '[data-testid="mermaid-diagram"]'

test.describe('@p1 mermaid preview — survives editor tab switch', () => {
  test('diagrams stay rendered and scroll position is kept after switching away and back', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const mdFsPath = writeMermaidMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    // 每张 mermaid 图的几何快照，用于对比切换前后是否变空。
    const snapshotAll = () =>
      page.evaluate((sel) => {
        return Array.from(document.querySelectorAll(sel)).map((d) => {
          const svg = d.querySelector('svg')
          const rect = svg?.getBoundingClientRect()
          return { w: Math.round(rect?.width ?? 0), h: Math.round(rect?.height ?? 0) }
        })
      }, DIAGRAM)

    // 文档里有 3 张图，等它们全部渲染出非空 SVG。
    const allRendered = async (): Promise<boolean> => {
      const snap = await snapshotAll()
      return snap.length === 3 && snap.every((s) => s.w > 0 && s.h > 0)
    }
    await expect.poll(allRendered, { timeout: 12000 }).toBe(true)

    // 滚到中部（让滚动位置成为可观测量）。
    const target = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement
      const t = Math.floor((el.scrollHeight - el.clientHeight) / 2)
      el.scrollTop = t
      el.dispatchEvent(new Event('scroll'))
      return el.scrollTop
    }, PREVIEW)
    expect(target).toBeGreaterThan(0)

    // 切到另一个 editor（同组新建 untitled）——卸载 MarkdownPreviewEditor。
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .not.toBe('markdown.preview')

    // 切回预览标签——重新挂载。
    await workbench.runCommand('workbench.action.previousEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('markdown.preview')

    // 断言 1（Bug 1）：切回后每张图仍有内容，不是空图。
    await expect.poll(allRendered, { timeout: 12000 }).toBe(true)

    // 断言 2（Bug 2）：滚动位置恢复到切走前（不是被重置到顶部）。restore 走
    // ResizeObserver 在内容稳定期间逐步逼近，故 poll 等待其收敛。
    await expect
      .poll(
        () =>
          page.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLElement | null
            return el?.scrollTop ?? -1
          }, PREVIEW),
        { timeout: 3000 },
      )
      .toBeGreaterThan(target - 40)

    const finalTop = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null
      return el?.scrollTop ?? -1
    }, PREVIEW)
    expect(finalTop).toBeLessThan(target + 40)
  })
})
