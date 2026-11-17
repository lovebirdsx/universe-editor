/*---------------------------------------------------------------------------------------------
 *  Closing a trigger session tab must leave the editor area closed.
 *
 *  Trigger sessions are created with activate:false and, by default, no tab, so
 *  several live background sessions accumulate. Closing the one tab the user
 *  opened used to make AcpSessionRegistry.remove fall back to the first remaining
 *  session; AgentsActiveSessionSyncContribution then opened that session's tab in
 *  the same group, so the closed tab appeared to turn into another session. The
 *  editor must follow the group's own next-tab handoff instead — never promote a
 *  background session.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { E2ETriggerAutomationRow, E2ETriggerSummary } from '@universe-editor/e2e-contract'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const TRIGGER_A = 'e2e-tab-close-a'
const TRIGGER_B = 'e2e-tab-close-b'

test.use({
  workspaceSeeder: {
    seed(dir: string) {
      writeFileSync(join(dir, 'README.md'), '# trigger session tab e2e\n')
    },
  },
})

function manualTrigger(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    enabled: false,
    showSession: false,
    source: { type: 'manual' },
    session: { agent: 'echo', mode: 'plan', prompt: 'Handle this E2E trigger event' },
    concurrency: 1,
    overflow: 'queue',
  }
}

async function listTriggers(page: Page): Promise<readonly E2ETriggerSummary[]> {
  return page.evaluate(() => window.__E2E__!.listTriggers())
}

async function findTrigger(page: Page, id: string): Promise<E2ETriggerSummary | undefined> {
  return (await listTriggers(page)).find((trigger) => trigger.id === id)
}

async function registerTriggers(page: Page, workspace: string): Promise<void> {
  const file = join(workspace, '.universe-editor', 'triggers.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify(
      {
        version: 1,
        triggers: [manualTrigger(TRIGGER_A, 'Trigger A'), manualTrigger(TRIGGER_B, 'Trigger B')],
      },
      null,
      2,
    ),
  )
  await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.triggers.openConfig'))
}

async function confirmTrigger(page: Page, id: string): Promise<string> {
  const summary = await findTrigger(page, id)
  if (summary === undefined) throw new Error(`trigger ${id} is not listed`)
  await page.evaluate((key) => window.__E2E__!.confirmTriggerActivation(key), summary.key)
  await expect.poll(async () => (await findTrigger(page, id))?.activationConfirmed).toBe(true)
  return summary.key
}

function sessionTabUris(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__E2E__!.getActiveGroupEditorUris().filter((uri) => uri.includes('/acp/session/')),
  )
}

async function automationRow(
  page: Page,
  triggerId: string,
): Promise<E2ETriggerAutomationRow | undefined> {
  const rows = await page.evaluate(() => window.__E2E__!.getAcpAutomationRows())
  return rows.find((row) => row.automation.triggerId === triggerId)
}

test.describe('trigger sessions and editor tabs', () => {
  test('closing an opened trigger session tab leaves the editor closed instead of opening another session @regression', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await workbench.runCommand('workbench.trust.grant')
    await page.evaluate(
      ([agentId, jsPath]) =>
        window.__E2E__!.installAcpEchoAgent(agentId, jsPath, { ECHO_AGENT_CONFIG_OPTIONS: '1' }),
      ['echo', ECHO_AGENT_PATH] as const,
    )
    await registerTriggers(page, launchWorkspace.dir)

    await expect.poll(async () => (await findTrigger(page, TRIGGER_A))?.status).toBe('paused')
    await expect.poll(async () => (await findTrigger(page, TRIGGER_B))?.status).toBe('paused')
    const keyA = await confirmTrigger(page, TRIGGER_A)
    const keyB = await confirmTrigger(page, TRIGGER_B)

    // Two unattended runs: both sessions are live, neither owns an editor tab.
    await page.evaluate((key) => window.__E2E__!.runTriggerNow(key), keyA)
    await expect
      .poll(async () => (await automationRow(page, TRIGGER_A))?.firstPrompt, { timeout: 30_000 })
      .toBeDefined()
    await page.evaluate((key) => window.__E2E__!.runTriggerNow(key), keyB)
    await expect
      .poll(async () => (await automationRow(page, TRIGGER_B))?.firstPrompt, { timeout: 30_000 })
      .toBeDefined()

    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(2)
    expect(await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())).toBeUndefined()
    expect(await sessionTabUris(page)).toEqual([])

    const rowA = await automationRow(page, TRIGGER_A)
    if (rowA === undefined) throw new Error('trigger A produced no automation row')

    // Open A exactly as a user would: the Sessions list row.
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.openView'))
    const row = page.getByTestId(`session-row-${rowA.sessionId}`)
    await expect(row).toBeVisible()
    await row.click()
    await expect.poll(() => sessionTabUris(page)).toHaveLength(1)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveAcpSessionId()))
      .toBeDefined()
    // Let A's echo turn settle so closing the tab does not ask "still running".
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 30_000 })
      .toBe('idle')

    await workbench.runCommand('workbench.action.closeActiveEditor')

    // Old behaviour: registry.remove promoted the first remaining live session
    // (B), and AgentsActiveSessionSyncContribution opened its tab in this group.
    await expect.poll(() => sessionTabUris(page), { timeout: 5_000 }).toEqual([])
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveAcpSessionId()))
      .toBeUndefined()
    expect(await page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())).not.toBe(
      'acp.session',
    )
    // B stays live: closing A's tab must close only A's session.
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(1)
    expect(await page.evaluate(() => window.__E2E__!.getAcpAutomationRows())).toHaveLength(2)

    // Give any deferred autorun a chance to resurrect the background tab.
    await page.waitForTimeout(250)
    expect(await sessionTabUris(page)).toEqual([])
  })
})
