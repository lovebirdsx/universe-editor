/*---------------------------------------------------------------------------------------------
 *  Session editor group-focus regression (@regression).
 *
 *  用户实测必现 bug：左右两个 editor group 各放一个 ACP session editor，焦点在
 *  左边会话的 prompt 输入框（内嵌 Monaco）时执行 focusNextGroup，焦点原地不动——
 *  右组是普通文本编辑器的相同操作则正常。
 *
 *  根因（本 spec 守护）：每个 ChatBody 的命令句柄（focusInput / timeline nav …）
 *  被写到模块级共享对象上，后挂载的会话劫持全部会话的路由；叠加同一 session
 *  分屏时按 sessionId 选 widget 不区分左右两份拷贝。
 *
 *  断言走 document.activeElement 的 [data-group-id] 祖先链（同 smoke.editorGroupSwitch
 *  手法），不戳 Monaco 内部结构。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import type { Page } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@regression session editor focus — focusNextGroup through session editors', () => {
  async function activeElementGroup(page: Page): Promise<string | null> {
    return page.evaluate(
      () =>
        document.activeElement
          ?.closest<HTMLElement>('[data-group-id]')
          ?.getAttribute('data-group-id') ?? null,
    )
  }

  async function groupIds(page: Page): Promise<string[]> {
    return page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-group-id]')).map(
        (el) => el.dataset['groupId']!,
      ),
    )
  }

  async function newEchoSession(page: Page, count: number): Promise<void> {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 15000 })
      .toBe(count)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')
  }

  /** 点击左组会话的 prompt 输入框拿到真实 DOM 焦点（用户现场）。 */
  async function focusPrompt(page: Page, groupId: string): Promise<void> {
    await page.locator(`[data-group-id="${groupId}"] [data-testid="acp-chat"]`).click()
    await page.locator(`[data-group-id="${groupId}"] .monaco-editor textarea`).first().focus()
    await expect.poll(() => activeElementGroup(page)).toBe(groupId)
  }

  test('focus switches between two distinct sessions in left/right groups', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // 左组 session A → 分屏建右组 → 右组另建 session B（左右各一个不同会话）。
    await newEchoSession(page, 1)
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    await newEchoSession(page, 2)

    const [leftId, rightId] = await groupIds(page)
    expect(leftId).toBeDefined()
    expect(rightId).toBeDefined()
    expect(leftId).not.toBe(rightId)

    await focusPrompt(page, leftId!)

    await workbench.runCommand('workbench.action.focusNextGroup')
    await expect.poll(() => activeElementGroup(page)).toBe(rightId)
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)

    await workbench.runCommand('workbench.action.focusPreviousGroup')
    await expect.poll(() => activeElementGroup(page)).toBe(leftId)
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
  })

  test('focus switches between two groups showing the same split session', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // 唯一会话分屏：左右两组显示同一 session 的两份拷贝。
    await newEchoSession(page, 1)
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    const [leftId, rightId] = await groupIds(page)
    await focusPrompt(page, leftId!)

    await workbench.runCommand('workbench.action.focusNextGroup')
    await expect.poll(() => activeElementGroup(page)).toBe(rightId)
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)

    await workbench.runCommand('workbench.action.focusPreviousGroup')
    await expect.poll(() => activeElementGroup(page)).toBe(leftId)
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
  })
})
