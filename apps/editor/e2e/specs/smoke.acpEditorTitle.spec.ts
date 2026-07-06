/*---------------------------------------------------------------------------------------------
 *  ACP Session Editor title-bar nav icons (@p1).
 *
 *  复现/守卫：当一个 acp.session editor 处于 active 时，editor tab 栏右上角应出现 5 个
 *  MenuId.EditorTitle inline 图标（当前 editor 新建 session + 上一条/下一条/顶部/底部）。这些图标由
 *  `activeEditorType == 'acp.session'` 门控，而 activeEditorType 写在每个 editor group
 *  的 scoped ContextKeyService 上（探针读不到 root key），故只能用 DOM testid 断言。
 *
 *  单测（EditorGroupView.titleActions.test.tsx）已证明渲染层正确；本 spec 在真实打包
 *  产物里跑全链路，确认运行时也确实出现这些图标。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const NAV_COMMANDS_IN_ORDER = [
  'workbench.action.agent.newSessionInCurrentEditor',
  'workbench.action.agent.focusPreviousTimelineItem',
  'workbench.action.agent.focusNextTimelineItem',
  'workbench.action.agent.focusTopTimelineItem',
  'workbench.action.agent.focusBottomTimelineItem',
]

const OVERFLOW_COMMANDS = [
  'workbench.action.agent.showSessionChanges',
  'workbench.action.agent.find',
  'workbench.action.agent.jumpToPlan',
]

test.describe('@p1 agents — editor title nav icons', () => {
  test('an active acp.session editor shows the 5 EditorTitle nav icons', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // 注入 echo agent 并设为默认。
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // 默认 chat location 为 'editor'，newSession 直接把会话当作全屏 editor 打开。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // 关键断言：5 个 inline 图标按钮都可见。
    for (const cmd of NAV_COMMANDS_IN_ORDER) {
      await expect(page.locator(`[data-testid="view-title-action-${cmd}"]`)).toBeVisible()
    }
    for (const cmd of OVERFLOW_COMMANDS) {
      await expect(page.locator(`[data-testid="view-title-action-${cmd}"]`)).toHaveCount(0)
    }
    await expect(page.getByTestId('editor-title-overflow')).toBeVisible()

    // 渲染顺序应为 order 0→5。
    const renderedOrder = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="view-title-action-"]')).map((el) =>
        (el as HTMLElement).dataset['testid']!.replace('view-title-action-', ''),
      ),
    )
    const navOnly = renderedOrder.filter(
      (id) =>
        id.startsWith('workbench.action.agent.') &&
        (id.includes('TimelineItem') ||
          id.includes('Timeline') ||
          id === 'workbench.action.agent.newSessionInCurrentEditor'),
    )
    expect(navOnly).toEqual(NAV_COMMANDS_IN_ORDER)
  })
})
