/*---------------------------------------------------------------------------------------------
 *  Session prompt Escape focus return (@regression).
 *
 *  用户实测 bug（必现）：
 *    1. 打开工作区恢复 session，焦点在 session 输入框
 *    2. Ctrl+Shift+E → 焦点到 explorer
 *    3. Esc → 焦点回到输入框 ✓
 *    4. 再次 Ctrl+Shift+E → explorer
 *    5. Esc → 焦点不再回到输入框 ✗
 *
 *  根因：`editorFocus` 过去由各编辑器自行 book-keep。ACP prompt 输入框是 editContext 的
 *  内嵌 Monaco，焦点宿主 `div.native-edit-context` 落在 `.monaco-editor` 子树内，而它没有
 *  接 `editorFocus` 的 blur 桥（FileEditor / LogOutputView 有）。于是第一次 Esc 命中全局
 *  绑定（when 含 `!editorFocus`）后，`focusEditorInput` 的 syncEditorFocusContext 把 key 写成
 *  true 并就此残留 —— 焦点移到 explorer 也没有任何代码清它；第二次 Esc 的 `!editorFocus`
 *  不成立，Esc 落到 weight 50 的 Monaco 镜像键被 defer，什么都不发生。
 *
 *  本 spec 同时守住两个不变量：焦点离开 prompt 后 `editorFocus` 必须落回 false（根因），
 *  以及每一次 Ctrl+Shift+E → Esc 往返都能把焦点送回输入框（用户可见行为）。
 *  断言只看 activeElement 落在哪个面 + contextKey，不戳 Monaco 内部。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'
import type { Page } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const EXPLORER_TREE = 'workbench.view.explorer.tree'
const POLL = { timeout: 15_000 }

/**
 * Ctrl+Shift+E with the real keybinding. Safe to press exactly once here:
 * `workbench.view.explorer` is a toggle that *closes* the side bar only when it is
 * already visible AND focused, and every call site below runs while the prompt
 * owns focus — so the reveal + focus branch is the only reachable one.
 */
async function focusExplorerByKeyboard(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+E')
}

test.describe('session prompt Escape focus — Ctrl+Shift+E → Esc round trip', () => {
  test('Escape returns focus to the session prompt input on every round trip @regression', async ({
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
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), POLL)
      .toBe('acp.session')

    // 前置护栏：新会话的焦点在输入框。这与用户复现的「启动恢复」落点同形 —— 组激活的焦点
    // pass 跑在 widget 注册之前（回落到 group body），随后 PromptInput 的 autoFocus 把焦点
    // 送进输入框，两条路都不让 prompt 认领 editorFocus。
    await expect.poll(() => workbench.getFocusedChatSurface(), POLL).toBe('prompt')

    // 第一轮 = 用户步骤 2-3（修复前就通过），第二轮 = 步骤 4-5（修复前必挂）。
    for (const round of [1, 2]) {
      await focusExplorerByKeyboard(page)
      await expect
        .poll(() => workbench.getContextKey<string>('focusedView'), {
          timeout: POLL.timeout,
          message: `round ${round}: Ctrl+Shift+E should land focus on the Explorer tree`,
        })
        .toBe(EXPLORER_TREE)
      await expect
        .poll(() => workbench.getContextKey<boolean>('sideBarFocus'), {
          timeout: POLL.timeout,
          message: `round ${round}: Ctrl+Shift+E should focus the side bar`,
        })
        .toBe(true)

      // 根因断言：焦点离开 prompt 后 editorFocus 必须是 false。残留 true 会让下一个
      // Escape 的 `!editorFocus` 不成立（Esc 被 Monaco 镜像层 defer 掉），焦点留在 explorer。
      await expect
        .poll(() => workbench.getContextKey<boolean>('editorFocus'), {
          timeout: POLL.timeout,
          message: `round ${round}: focus left the Monaco prompt, so editorFocus must be false`,
        })
        .toBe(false)

      // 真键盘，不能用 runCommand —— runCommand 绕过 keybinding 的 when 解析。
      await page.keyboard.press('Escape')

      await expect
        .poll(() => workbench.getFocusedChatSurface(), {
          timeout: POLL.timeout,
          message: `round ${round}: Escape should return focus to the session prompt input`,
        })
        .toBe('prompt')
      await expect
        .poll(() => workbench.getContextKey<boolean>('editorFocus'), {
          timeout: POLL.timeout,
          message: `round ${round}: focus is back in the prompt's Monaco, so editorFocus must be true`,
        })
        .toBe(true)
      await expect
        .poll(() => workbench.getContextKey<boolean>('acpChatFocused'), {
          timeout: POLL.timeout,
          message: `round ${round}: focus should be back inside the chat`,
        })
        .toBe(true)
    }
  })
})
