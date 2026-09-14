/*---------------------------------------------------------------------------------------------
 *  Session editor focus-restore regression (@regression).
 *
 *  用户实测 bug：焦点在 session editor 的 message card（时间线消息卡）上，切到同组的
 *  另一个 editor 标签再切回来，焦点被塞进 session input（prompt 输入框）。
 *
 *  根因（本 spec 守护）：切 tab 会卸载整棵 ChatBody，切回来重挂载时
 *  ① PromptInput 的 mount autoFocus 抢焦点；② EditorGroupView 的组激活焦点 pass
 *  在 layout 阶段跑，而 ChatBody 的 widget 注册在 passive 阶段——focus pass 找不到
 *  widget 就落到 group body。修复后 ChatBody 记住「最后获得焦点的面」，重挂载时把
 *  焦点还给时间线滚动容器。
 *
 *  断言只看 document.activeElement 落在哪个面（acp-prompt 表单内 = 输入框，
 *  其余在 acp-chat 内 = 时间线）与 acpChatFocused contextKey，不戳 Monaco 内部。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'
import type { Page } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const POLL = { timeout: 15000 }

/** Which surface inside the chat owns DOM focus right now. */
function focusedSurface(page: Page): Promise<'prompt' | 'timeline' | 'none'> {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof Element)) return 'none'
    if (active.closest('[data-testid="acp-prompt"]')) return 'prompt'
    if (active.closest('[data-testid="acp-chat"]')) return 'timeline'
    return 'none'
  })
}

/** Is the focused element the timeline's scroll container itself (not a descendant)? */
function focusIsOnTimelineContainer(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="acp-timeline"]')?.parentElement
    return scroll !== null && scroll !== undefined && document.activeElement === scroll
  })
}

test.describe('session editor focus — message card focus survives a tab round trip', () => {
  test('keeps the timeline focus when switching away to another editor and back @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    // 启动焦点恢复晚于 waitForRestored，不等它就会被中途抢焦点。
    await workbench.waitForBootstrapFocusSettled()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // 默认 chat location 为 'editor'，newSession 直接把会话当作全屏 session editor 打开。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), POLL).toBe(1)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // 护栏：新会话首次打开仍然是输入框焦点（记忆为空 → 默认面是输入框）。
    await expect.poll(() => focusedSurface(page)).toBe('prompt')

    // 一条 prompt 换来一条可点的 agent 消息卡。sendAcpPrompt 的 await 不等渲染。
    await page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), 'alpha')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages().length), POLL)
      .toBe(2)

    const card = page.locator('[data-testid="acp-message-agent"]').first()
    await expect(card).toBeVisible()
    await card.click()
    await expect.poll(() => focusedSurface(page)).toBe('timeline')
    await expect.poll(() => focusIsOnTimelineContainer(page)).toBe(true)

    // 同组切到另一个 editor（新建 untitled）——ChatBody 整棵卸载。
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), POLL)
      .not.toBe('acp.session')

    // 切回会话标签——重挂载，应当把焦点还给时间线而不是输入框（原 bug）。
    await workbench.runCommand('workbench.action.previousEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), POLL)
      .toBe('acp.session')
    await expect.poll(() => focusedSurface(page)).toBe('timeline')
    await expect.poll(() => focusIsOnTimelineContainer(page)).toBe(true)
    // 焦点真的落在 chat 内 → Alt+J/K 立刻可用。
    await expect.poll(() => workbench.getContextKey<boolean>('acpChatFocused')).toBe(true)

    // 反向护栏：焦点移回输入框后，再次往返应当回到输入框。
    await page.locator('[data-testid="acp-prompt"] .monaco-editor textarea').first().focus()
    await expect.poll(() => focusedSurface(page)).toBe('prompt')

    // 用已有的两个标签往返（previous/nextEditor 按标签位置翻页，不造新标签：
    // 会话与 untitled 相邻，翻页即互达）。
    await workbench.runCommand('workbench.action.nextEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), POLL)
      .not.toBe('acp.session')
    await workbench.runCommand('workbench.action.previousEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), POLL)
      .toBe('acp.session')
    await expect.poll(() => focusedSurface(page)).toBe('prompt')
  })
})
