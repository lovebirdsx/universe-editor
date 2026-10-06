import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'

const ECHO_AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/test-fixtures/echoAgent.cjs',
)

/** 计划权限策略只对内置 Claude 身份生效；桩 agent 显式占用该 id 来模拟它。 */
const CLAUDE_AGENT_ID = 'claude-code'

const POLICY_KEY = 'agentSettings.claude.planPermissionPolicy'

/**
 * ECHO_AGENT_CONFIG_OPTIONS=1 让 session/new 直接通告 mode=plan，省去手动切模式。
 * 默认按 `claude-code` 身份安装 echo 桩——`isClaudeAgent` 判的是 agentId，别的 id
 * 走的是通用自动批准路径，测不到计划权限策略。
 */
async function startPlanSession(page: Page, agentId: string = CLAUDE_AGENT_ID) {
  await page.evaluate(
    ([id, path]) =>
      window.__E2E__!.installAcpEchoAgent(id, path, { ECHO_AGENT_CONFIG_OPTIONS: '1' }),
    [agentId, ECHO_AGENT_PATH] as const,
  )
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(1)
}

async function sendPrompt(page: Page, text: string) {
  await page.evaluate((value) => {
    void window.__E2E__!.sendAcpPrompt(value)
  }, text)
}

async function expectSelection(page: Page, optionId: string) {
  await expect
    .poll(
      async () => {
        const messages = await page.evaluate(() => window.__E2E__!.getAcpMessages())
        return messages.map((message) => message.text).join('\n')
      },
      { timeout: 15000 },
    )
    .toContain(`"optionId":"${optionId}"`)
}

/** 负例：卡片必须先出现，点选后再断言 Agent 收到的 optionId。 */
async function respondAndExpect(page: Page, buttonName: string, optionId: string) {
  const card = page.getByTestId('acp-permission-card')
  await expect(card).toHaveCount(1)
  await card.getByRole('button', { name: buttonName, exact: true }).click()
  await expectSelection(page, optionId)
}

test('Claude 计划会话默认 skip：静默选「仅本次允许」且不弹卡 @p1', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell')

  await expectSelection(page, 'allow-once')
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
})

test('skip 覆盖拒绝项置顶（CLI defaultToNo）的询问 @regression', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell-danger')

  await expectSelection(page, 'allow-once')
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
})

test('没有一次性允许选项时回人工卡片，不代选永久授权 @regression', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell-persistent-only')

  await respondAndExpect(page, 'No', 'reject')
})

test('User 层设为 manual 后请求回人工卡片 @regression', async ({ page }) => {
  await page.evaluate((key) => window.__E2E__!.updateUserConfigValue(key, 'manual'), POLICY_KEY)
  await expect
    .poll(() =>
      page.evaluate((key) => window.__E2E__!.getConfigurationValueOrigin(key), POLICY_KEY),
    )
    .toBe('user')
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell')

  await respondAndExpect(page, 'Yes', 'allow-once')
})

test('User 层设为 auto 后客户端不自动批准（放行交给 CLI 分类器）@regression', async ({ page }) => {
  await page.evaluate((key) => window.__E2E__!.updateUserConfigValue(key, 'auto'), POLICY_KEY)
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell')

  await respondAndExpect(page, 'Yes', 'allow-once')
})

test('Memory 层的策略值被忽略（仅个人层生效）@regression', async ({ page }) => {
  await page.evaluate((key) => window.__E2E__!.updateConfigValue(key, 'manual'), POLICY_KEY)
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell')

  await expectSelection(page, 'allow-once')
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
})

test('非 Claude 身份不受计划权限策略影响：仍弹卡 @regression', async ({ page }) => {
  await startPlanSession(page, 'echo')
  await sendPrompt(page, 'approve-shell')

  await respondAndExpect(page, 'Yes', 'allow-once')
})

// 子/主 agent 与各类 CLI 标记在 skip 下不再区分：一律只放行一次、不写规则。
// 这些用例守护的是「不因 kind / 归属 / marker 而漏答或改写策略」。

test('子 agent 的 WebSearch（kind=fetch）静默选「仅本次允许」@p1', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-web-search')

  await expectSelection(page, 'allow-once')
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
})

test('主 agent 的 WebSearch 同样静默放行一次 @p1', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-web-main')

  await expectSelection(page, 'allow-once')
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
})

test('CLI 显式否定（marker=false）的 WebSearch 同样只放行一次 @regression', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-web-denied')

  await expectSelection(page, 'allow-once')
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
})

test('命中用户 ask 规则的 WebSearch 同样只放行一次 @regression', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-web-ask')

  await expectSelection(page, 'allow-once')
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
})
