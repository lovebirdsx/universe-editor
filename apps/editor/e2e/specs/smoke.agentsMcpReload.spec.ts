/*---------------------------------------------------------------------------------------------
 *  Session MCP picker reload regression (@p1).
 *
 *  Repro: define an MCP server in `acp.mcpServers` and disable it by default
 *  (enablement storage), create a session (never messaged → hasMessages=false),
 *  then enable the server from the session MCP picker. The seamless reload
 *  closed the session and tried to `session/load` it — but real agents never
 *  persist an empty session, so the load failed, the resume-failure policy
 *  discarded the row, and the session simply vanished from the list. The fix
 *  detects the empty session and replaces it with a fresh session pinned to
 *  the new selection instead of resuming the old one.
 *
 *  The echo fixture mirrors real-agent persistence semantics with
 *  ECHO_AGENT_LOAD_SESSION=1: session/load succeeds only for sessions that
 *  ran at least one prompt, so the pre-fix build reliably loses the session
 *  here.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

async function setupEchoSession(page: import('@playwright/test').Page) {
  await page.evaluate(() =>
    window.__E2E__!.updateConfigValue('acp.mcpServers', {
      web: { command: 'node', args: ['-e', ''] },
    }),
  )
  // Default-disabled at the user (GLOBAL) scope — the session starts without
  // the server until the picker explicitly enables it.
  await page.evaluate(() => window.__E2E__!.setAcpMcpServerEnabled('web', false))
  await page.evaluate(([id, p, env]) => window.__E2E__!.installAcpEchoAgent(id, p, env), [
    'echo',
    ECHO_AGENT_PATH,
    { ECHO_AGENT_LOAD_SESSION: '1' },
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 10000 })
    .toBe('idle')
}

test.describe('@p1 agents session MCP reload', () => {
  test('enabling a disabled MCP server on a fresh session keeps the session alive @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await setupEchoSession(page)

    const beforeId = await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())
    await page.evaluate(() => window.__E2E__!.setAcpSessionMcpServers(['web']))

    // The reload swaps the session; the replacement must stay alive (pre-fix
    // the count dropped to 0 and stayed there).
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 15000 })
      .toBe('idle')
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(1)
    expect(await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())).not.toBe(beforeId)

    // The replacement session must forward the enabled server on session/new.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('report-mcp-servers'))
    await expect
      .poll(
        async () => {
          const messages = await page.evaluate(() => window.__E2E__!.getAcpMessages())
          return messages.find((m) => m.role === 'agent')?.text ?? ''
        },
        { timeout: 5000 },
      )
      .toContain('"name":"web"')
  })

  test('toggling MCP servers on a messaged session reloads via session/load', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await setupEchoSession(page)

    // Give the session real content so the reload takes the session/load path.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
      .toEqual([
        { role: 'user', text: 'hello' },
        { role: 'agent', text: 'echo: hello' },
      ])

    await page.evaluate(() => window.__E2E__!.setAcpSessionMcpServers(['web']))

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 15000 })
      .toBe('idle')
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(1)

    // session/load forwarded the new whitelist to the agent.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('report-mcp-servers'))
    await expect
      .poll(
        async () => {
          const messages = await page.evaluate(() => window.__E2E__!.getAcpMessages())
          return messages.map((m) => m.text).find((t) => t.includes('"name"')) ?? ''
        },
        { timeout: 5000 },
      )
      .toContain('"name":"web"')
  })
})
