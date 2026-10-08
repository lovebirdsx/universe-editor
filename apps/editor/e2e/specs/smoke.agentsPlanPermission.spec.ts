import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'

const ECHO_AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/test-fixtures/echoAgent.cjs',
)

async function requestPlan(
  page: Page,
  mode: string,
  {
    agentId = 'claude-code',
    directive = 'approve-plan',
  }: { agentId?: string; directive?: string } = {},
) {
  // 默认按内置 `claude-code` 身份安装 echo 桩：switch_mode 不走计划权限策略的判据之一是
  // 「Claude 会话」，用别的 id 就测不到那条排除。codex 用例改传 `codex`（计划审查选项是
  // fork 自己的契约，与身份无关，但用真实身份更贴近线上）。
  await page.evaluate(([id, path]) => window.__E2E__!.installAcpEchoAgent(id, path), [
    agentId,
    ECHO_AGENT_PATH,
  ] as const)
  await page.evaluate(
    (value) => window.__E2E__!.updateConfigValue('acp.plan.autoExecute', value),
    mode,
  )
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(1)
  await page.mouse.move(0, 0)
  await page.evaluate((text) => {
    void window.__E2E__!.sendAcpPrompt(text)
  }, directive)
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
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
}

test('计划确认展示全部选项并回传手动选择 @regression', async ({ page }) => {
  await requestPlan(page, 'off')
  const card = page.getByTestId('acp-permission-card')
  await expect(card.locator('button[data-option-id]')).toHaveText([
    'Yes, clear context (41% used) and use auto mode',
    'Yes, and use auto mode',
    'Yes, and bypass permissions',
    'Yes, manually approve edits',
    'No, keep planning',
  ])
  await expect(page.getByTestId('acp-permission-auto-countdown')).toHaveCount(0)
  await card.getByRole('button', { name: 'Yes, and bypass permissions', exact: true }).click()
  await expectSelection(page, 'exit-plan-bypass')
})

for (const [mode, optionId] of [
  ['auto', 'exit-plan-auto'],
  ['bypassPermissions', 'exit-plan-bypass'],
] as const) {
  test(`计划倒计时按 ${mode} 自动执行且不清上下文 @regression`, async ({ page }) => {
    await requestPlan(page, mode)
    await expect(page.getByTestId('acp-permission-auto-countdown')).toHaveCount(1)
    await expectSelection(page, optionId)
  })
}

// codex 的计划审查卡只有 implement_plan / revise_plan，没有 exit-plan-* 分档；
// 非 off 的任何档位都应自动选 implement_plan（选项契约与 agent 身份无关）。
for (const mode of ['bypassPermissions', 'acceptEdits'] as const) {
  test(`codex 计划卡按 ${mode} 倒计时自动实现计划，且不渲染 steer 输入框 @regression`, async ({
    page,
  }) => {
    await requestPlan(page, mode, { agentId: 'codex', directive: 'approve-plan-codex' })
    await expect(page.getByTestId('acp-permission-auto-countdown')).toHaveCount(1)
    // codex 只读 optionId、不读 `_meta.feedback`，意见输入框必须不渲染。
    await expect(page.getByTestId('acp-permission-steer-input')).toHaveCount(0)
    await expectSelection(page, 'implement_plan')
  })
}

test('codex 计划只提供 revise_plan 时回退人工确认 @regression', async ({ page }) => {
  await requestPlan(page, 'bypassPermissions', {
    agentId: 'codex',
    directive: 'approve-plan-codex-revise-only',
  })
  await expect(page.getByTestId('acp-permission-auto-countdown')).toHaveCount(0)
  await page
    .getByTestId('acp-permission-card')
    .getByRole('button', { name: 'No, and tell Codex what to do differently' })
    .click()
  await expectSelection(page, 'revise_plan')
})
