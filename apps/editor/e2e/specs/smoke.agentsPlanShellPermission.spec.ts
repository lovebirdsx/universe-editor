import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'

const ECHO_AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/test-fixtures/echoAgent.cjs',
)

/** ECHO_AGENT_CONFIG_OPTIONS=1 让 session/new 直接通告 mode=plan，省去手动切模式。 */
async function startPlanSession(page: Page) {
  await page.evaluate(
    ([id, path]) =>
      window.__E2E__!.installAcpEchoAgent(id, path, { ECHO_AGENT_CONFIG_OPTIONS: '1' }),
    ['echo', ECHO_AGENT_PATH] as const,
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

test('计划模式下作用域化 Shell 权限默认静默批准 @p1', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell')

  await expectSelection(page, 'allow-with-updates')
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
})

test('关闭 acp.plan.autoApproveWithUpdates 后权限卡回归 @regression', async ({ page }) => {
  await startPlanSession(page)
  await page.evaluate(
    (key) => window.__E2E__!.updateConfigValue(key, false),
    'acp.plan.autoApproveWithUpdates',
  )
  await sendPrompt(page, 'approve-shell')

  const card = page.getByTestId('acp-permission-card')
  await expect(card).toHaveCount(1)
  await card.getByRole('button', { name: 'Yes', exact: true }).click()
  await expectSelection(page, 'allow-once')
})

test('拒绝项置顶（defaultToNo）时不静默批准 @regression', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell-danger')

  const card = page.getByTestId('acp-permission-card')
  await expect(card).toHaveCount(1)
  await card.getByRole('button', { name: 'No', exact: true }).click()
  await expectSelection(page, 'reject')
})

test('无作用域选项时（主 agent 已盖章）静默选「仅本次允许」@p1', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell-once')

  await expectSelection(page, 'allow-once')
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
})

test('关闭 acp.plan.autoApproveUnscoped 后无作用域选项仍弹卡 @regression', async ({ page }) => {
  await startPlanSession(page)
  await page.evaluate(
    (key) => window.__E2E__!.updateConfigValue(key, false),
    'acp.plan.autoApproveUnscoped',
  )
  await sendPrompt(page, 'approve-shell-once')

  const card = page.getByTestId('acp-permission-card')
  await expect(card).toHaveCount(1)
  await card.getByRole('button', { name: 'Yes', exact: true }).click()
  await expectSelection(page, 'allow-once')
})

test('旧 fork 未盖章时无作用域选项不静默批准 @regression', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell-once-nomarker')

  const card = page.getByTestId('acp-permission-card')
  await expect(card).toHaveCount(1)
  await card.getByRole('button', { name: 'Yes', exact: true }).click()
  await expectSelection(page, 'allow-once')
})

test('子 agent 的询问无标记也静默批准 @regression', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell-once-subagent')

  await expectSelection(page, 'allow-once')
  await expect(page.getByTestId('acp-permission-card')).toHaveCount(0)
})

test('子 agent 的询问被 CLI 显式否定时仍弹卡 @regression', async ({ page }) => {
  await startPlanSession(page)
  await sendPrompt(page, 'approve-shell-once-subagent-denied')

  const card = page.getByTestId('acp-permission-card')
  await expect(card).toHaveCount(1)
  await card.getByRole('button', { name: 'Yes', exact: true }).click()
  await expectSelection(page, 'allow-once')
})
