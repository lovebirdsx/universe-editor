import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'

const ECHO_AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/test-fixtures/echoAgent.cjs',
)

async function requestPlan(page: Page, mode: string) {
  await page.evaluate(([id, path]) => window.__E2E__!.installAcpEchoAgent(id, path), [
    'echo',
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
  await page.evaluate(() => {
    void window.__E2E__!.sendAcpPrompt('approve-plan')
  })
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
