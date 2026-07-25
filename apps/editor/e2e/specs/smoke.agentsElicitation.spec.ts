/*---------------------------------------------------------------------------------------------
 *  ACP elicitation smoke test (@p1).
 *
 *  全链路烟雾：echo agent 的 elicit-form / elicit-url 指令触发标准
 *  elicitation/create 请求，断言编辑器表单卡 / consent 卡出现，用户应答
 *  round-trip 回 agent（agent 把结果回显为消息）。url 的 accept → waiting →
 *  elicitation/complete → done 流转也一并覆盖；不真开浏览器（opener 的真实
 *  跳转由组件测试覆盖，这里只走探针直接 settle）。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

async function setupEchoSession(page: import('@playwright/test').Page) {
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
    .toBe(1)
}

test.describe('@p1 agents elicitation', () => {
  test('form elicitation round-trips accept content to the agent', async ({ page }) => {
    await setupEchoSession(page)

    // fire-and-forget — the prompt only completes after the elicitation settles.
    await page.evaluate(() => {
      void window.__E2E__!.sendAcpPrompt('elicit-form')
    })

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPendingElicitation()), {
        timeout: 5000,
      })
      .toEqual({ mode: 'form', message: 'Pick your settings', fields: ['name', 'color'] })

    await page.evaluate(() =>
      window.__E2E__!.resolveAcpElicitation({ name: 'universe', color: 'blue' }),
    )
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPendingElicitation()))
      .toBeUndefined()

    // The agent echoes the settled response as a message.
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.__E2E__!.getAcpMessages()))
            .map((m) => m.text)
            .join('\n'),
        { timeout: 5000 },
      )
      .toContain('"action":"accept"')
    const texts = (await page.evaluate(() => window.__E2E__!.getAcpMessages()))
      .map((m) => m.text)
      .join('\n')
    expect(texts).toContain('"name":"universe"')
    expect(texts).toContain('"color":"blue"')
  })

  test('form decline via the card button settles decline', async ({ page }) => {
    await setupEchoSession(page)

    await page.evaluate(() => {
      void window.__E2E__!.sendAcpPrompt('elicit-form')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPendingElicitation()), {
        timeout: 5000,
      })
      .not.toBeUndefined()

    await page.getByTestId('acp-elicitation-decline').click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPendingElicitation()))
      .toBeUndefined()
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.__E2E__!.getAcpMessages()))
            .map((m) => m.text)
            .join('\n'),
        { timeout: 5000 },
      )
      .toContain('"action":"decline"')
  })

  test('url consent card shows the full URL; accept waits then flips done on complete', async ({
    page,
  }) => {
    await setupEchoSession(page)

    await page.evaluate(() => {
      void window.__E2E__!.sendAcpPrompt('elicit-url')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPendingElicitation()), {
        timeout: 5000,
      })
      .toMatchObject({ mode: 'url', message: 'Authorize the echo agent' })

    // Consent card: full URL with the domain highlighted, nothing auto-opened.
    await expect(page.getByTestId('acp-elicitation-url')).toHaveText(
      'https://auth.example.test/flow?token=abc',
    )
    await expect(page.getByTestId('acp-elicitation-url').locator('strong')).toHaveText(
      'auth.example.test',
    )

    // Accept via the probe (skips the real browser open — covered by unit tests).
    // The fixture fires elicitation/complete the instant accept round-trips, so
    // the waiting state is transient here — assert the terminal done state.
    await page.evaluate(() => window.__E2E__!.resolveAcpElicitation({}))
    await expect(page.getByTestId('acp-elicitation-url-done')).toBeVisible({ timeout: 5000 })

    // Dismiss tears the card down locally.
    await page.getByTestId('acp-elicitation-close').click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPendingElicitation()))
      .toBeUndefined()
  })
})
