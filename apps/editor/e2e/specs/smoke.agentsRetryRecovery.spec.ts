import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const ECHO_AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'test-fixtures',
  'echoAgent.cjs',
)

for (const failures of [1, 3]) {
  test(`同会话在 ${failures} 次失败后以新消息 UUID 恢复 @regression`, async ({ page }) => {
    await page.evaluate(([id, path]) => window.__E2E__!.installAcpEchoAgent(id, path), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(1)

    const prompt = `retry-dedup:${failures}`
    await page.evaluate((text) => {
      void window.__E2E__!.sendAcpPrompt(text)
    }, prompt)
    const recovery = page.getByTestId('acp-recovery-bar')
    await expect(recovery).toBeVisible()
    if (failures === 3) {
      const retry = page.getByTestId('acp-recovery-retry')
      await expect(retry).toBeVisible({ timeout: 20000 })
      await retry.click()
    }

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages().map((m) => m.text)), {
        timeout: 15000,
      })
      .toContain('retry-dedup recovered')
    await expect(recovery).toBeHidden()
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(1)
    const messages = await page.evaluate(() => window.__E2E__!.getAcpMessages())
    expect(messages.filter((m) => m.role === 'user' && m.text === prompt)).toHaveLength(1)
  })
}
