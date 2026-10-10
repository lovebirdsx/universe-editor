/*---------------------------------------------------------------------------------------------
 *  孤立预览下的外部改写：大纲必须跟上（@regression）
 *
 *  守护用户报的 bug：AI agent 整篇重写某个 .md 时，用户正停在它的 markdown 预览上——而这个
 *  预览是「孤立预览」（link 跳转 / 资源管理器 Open Preview / 恢复的裸预览），源文件没有
 *  FileEditorInput 标签。盘上文本经 ExternalChangeWatcher._reconcilePreviews 的 orphan 分支
 *  最小编辑进共享 model，预览更新了，大纲却永远停在旧树。
 *
 *  为什么只有孤立预览复现：大纲 tracker 与 DocumentSyncContribution 都按 200ms 防抖重算、
 *  且都订阅同一个 model.onDidChangeContent —— 谁先订阅谁的定时器先 fire（推送在首个 await
 *  之前同步上线）。孤立预览的源 model 由预览组件 acquire，而 tracker 的 onDidAddModel 监听
 *  在 main.tsx 构造 OutlineService 时已注册、早于 AfterRestore 的 DocumentSyncContribution
 *  → 符号请求先到宿主 → markdown LS 的 TOC 按 URI 缓存、只由 $didChange 失效，于是秒回旧树
 *  → 旧树非空，被 OutlineSymbolCache 与 wire 层版本缓存按【新】model 版本吃下 → 此后每次
 *  recompute 都命中缓存直接 republish，永久固化。源标签已打开的 toggle 预览 / 普通编辑路径
 *  订阅顺序相反（DSC 先订阅 → 推送先上线），所以 markdownPreview.spec.ts 的 outline 用例
 *  测不出这条。
 *
 *  断言形状：孤立预览（链接跳转而来、同组无 file: 源标签）→ 外部整篇重写 → 预览 DOM 先新
 *  → 大纲出现新标题。修复前最后一条永不成立（旧树按新版本固化，不再上线拉取）。
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/coreMarkdownApp.js'

const INDEX_MD = '# Index\n\n[q](./questions.md)\n'
/** 外部 agent 重写前的版本：待回复标题下只有一条旧问题。 */
const QUESTIONS_V1 = '# Waiting\n\n## Q-0311 old\n\nbody\n'
/** 重写后的版本：多了 Q-0312（用户现场缺的那条）。 */
const QUESTIONS_V2 = '# Waiting\n\n## Q-0311 old\n\nbody\n\n## Q-0312 new\n\nbody\n'

const PREVIEW = '[data-testid="markdown-preview"]'
/** 冷启 + LSP warmup 后还要等一次外部改写 + 两层防抖，CI 上给足窗口。 */
const RELOAD_TIMEOUT_MS = 20_000

test.describe('outline follows an external rewrite of an isolated preview', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'index.md'), INDEX_MD)
        writeFileSync(join(dir, 'questions.md'), QUESTIONS_V1)
      },
    },
  })

  test('link-reached preview shows the new heading after the file is rewritten on disk @regression', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    test.slow()
    if (!launchWorkspace) throw new Error('workspaceSeeder 未生效')
    const questions = launchWorkspace.file('questions.md')

    await workbench.waitForRestored()
    // Workspace watcher 武装之前写盘不产生任何事件——等订阅落地，而不是与它竞速。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.isWorkspaceWatchArmed()), { timeout: 30_000 })
      .toBe(true)

    // 打开 index.md 的预览，再点它里面的链接跳到 questions.md 的预览：链接跳转只开预览
    // （openPreviewInGroup），源文件不会拿到 FileEditorInput —— 这正是要复现的「孤立预览」。
    await page.evaluate(
      (fsPath) => window.__E2E__!.openFileUri(fsPath),
      launchWorkspace.file('index.md'),
    )
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')
    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('markdown.preview')

    const link = page.locator(`${PREVIEW} a`).first()
    await expect(link).toBeVisible()
    await link.click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 10_000 })
      .toEqual(expect.stringContaining('questions.md'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('markdown.preview')
    // 前提钉死：同组里没有 questions.md 的 file: 标签。源文件若真开着，订阅顺序反转，用例
    // 就会在（本来就正常的）toggle 路径上假绿。
    const uris = await page.evaluate(() => window.__E2E__!.getActiveGroupEditorUris())
    expect(uris.filter((u) => u.startsWith('file:') && u.includes('questions.md'))).toEqual([])

    // 改盘前大纲是活的：排除「本来就没有符号」这种假红。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), {
        timeout: RELOAD_TIMEOUT_MS,
      })
      .toContain('## Q-0311 old')

    // 外部整篇重写（agent 的写法：整篇覆盖）。写盘放在轮询里：watcher 武装与该路径的子订阅
    // 之间仍可能有窗口；重复写同内容是 no-op（最小编辑会判定相等，连版本都不动）。
    await expect
      .poll(
        async () => {
          writeFileSync(questions, QUESTIONS_V2)
          return page.locator(PREVIEW).first().innerText()
        },
        { timeout: RELOAD_TIMEOUT_MS, intervals: [500, 500, 1000] },
      )
      .toContain('Q-0312 new')

    // 核心断言：同一次改写，大纲也必须出现新标题。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), {
        timeout: RELOAD_TIMEOUT_MS,
      })
      .toContain('## Q-0312 new')
  })
})
