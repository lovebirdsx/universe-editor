/*---------------------------------------------------------------------------------------------
 *  Agent triggers end-to-end: the main-process scheduler accepting a manual event,
 *  the owning window creating an unattended (inactive) session, the rendered prompt
 *  carrying its untrusted-data fence into durable history, and the elevated-mode
 *  confirmation gate. Config lives in `<userData>/triggers/triggers.json`, which the
 *  spec writes through the probe-reported path (cold fixture isolates userData
 *  per test, so state never leaks between cases).
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { E2ETriggerAutomationRow, E2ETriggerSummary } from '@universe-editor/e2e-contract'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const MANUAL_ID = 'e2e-manual'
const ELEVATED_ID = 'e2e-elevated'
const INVALID_ID = 'e2e-broken'

test.use({
  workspaceSeeder: {
    seed(dir: string) {
      writeFileSync(join(dir, 'README.md'), '# trigger e2e workspace\n')
    },
  },
})

/** Write the trigger config through the path the main process reports. */
async function writeTriggersConfig(page: Page, triggers: readonly unknown[]): Promise<void> {
  const file = await page.evaluate(() => window.__E2E__!.getTriggersConfigPath())
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, maxConcurrentRuns: 2, triggers }, null, 2))
}

async function listTriggers(page: Page): Promise<readonly E2ETriggerSummary[]> {
  return page.evaluate(() => window.__E2E__!.listTriggers())
}

async function waitForTriggerStatus(page: Page, id: string, status: string): Promise<void> {
  await expect
    .poll(async () => (await listTriggers(page)).find((trigger) => trigger.id === id)?.status, {
      timeout: 15_000,
    })
    .toBe(status)
}

async function installEchoAgent(page: Page): Promise<void> {
  await page.evaluate(([agentId, jsPath]) => window.__E2E__!.installAcpEchoAgent(agentId, jsPath), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
}

function manualTrigger(workspace: string, id: string = MANUAL_ID): Record<string, unknown> {
  return {
    id,
    name: 'E2E Manual Trigger',
    enabled: false,
    workspace,
    source: { type: 'manual' },
    session: { agent: 'echo', prompt: 'Handle this E2E trigger event' },
    allowedActions: [],
    concurrency: 1,
    overflow: 'queue',
  }
}

async function activeAutomationRow(
  page: Page,
  triggerId: string,
): Promise<E2ETriggerAutomationRow | undefined> {
  const rows = await page.evaluate(() => window.__E2E__!.getAcpAutomationRows())
  return rows.find((row) => row.automation.triggerId === triggerId)
}

function runNowRejection(page: Page, triggerId: string): Promise<string | undefined> {
  return page.evaluate(async (id) => {
    try {
      await window.__E2E__!.runTriggerNow(id)
      return undefined
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }, triggerId)
}

test.describe('agent triggers', () => {
  test('with no triggers.json nothing is listed and no session is created @p0', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    expect(await listTriggers(page)).toEqual([])
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)
    expect(await page.evaluate(() => window.__E2E__!.getAcpHistoryCount())).toBe(0)
  })

  test('a manual trigger starts an inactive session whose first prompt carries the event fence @p0', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await workbench.runCommand('workbench.trust.grant')
    await installEchoAgent(page)
    await writeTriggersConfig(page, [manualTrigger(launchWorkspace.dir)])
    await waitForTriggerStatus(page, MANUAL_ID, 'disabled')

    const editorsBefore = await page.evaluate(() => window.__E2E__!.getActiveGroupEditorCount())
    await page.evaluate((id) => window.__E2E__!.runTriggerNow(id), MANUAL_ID)

    await expect
      .poll(
        async () =>
          (await activeAutomationRow(page, MANUAL_ID))?.firstPrompt?.includes('<event-data'),
        { timeout: 30_000 },
      )
      .toBe(true)

    const row = await activeAutomationRow(page, MANUAL_ID)
    expect(row).toBeDefined()
    expect(row!.automation.triggerName).toBe('E2E Manual Trigger')
    expect(row!.automation.eventKey).toMatch(/^manual:/)
    expect(row!.automation.runId.length).toBeGreaterThan(0)
    expect(row!.agentId).toBe('echo')

    const prompt = row!.firstPrompt!
    expect(prompt).toContain('Handle this E2E trigger event')
    expect(prompt).toContain(
      `<event-data trigger="${MANUAL_ID}" key="${row!.automation.eventKey}">`,
    )
    expect(prompt).toContain('</event-data>')

    // activate:false — the session is registered but stays out of the editor area.
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(1)
    expect(await page.evaluate(() => window.__E2E__!.getAcpHistoryCount())).toBe(1)
    expect(await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())).toBeUndefined()
    expect(await page.evaluate(() => window.__E2E__!.getActiveGroupEditorCount())).toBe(
      editorsBefore,
    )
  })

  test('an elevated mode is refused until the user confirms it @p0', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await installEchoAgent(page)
    await writeTriggersConfig(page, [
      {
        ...manualTrigger(launchWorkspace.dir, ELEVATED_ID),
        session: {
          agent: 'echo',
          mode: 'bypassPermissions',
          prompt: 'Elevated run',
        },
      },
    ])
    await waitForTriggerStatus(page, ELEVATED_ID, 'needs-confirmation')

    const summary = (await listTriggers(page)).find((trigger) => trigger.id === ELEVATED_ID)
    expect(summary?.elevatedMode).toBe(true)
    expect(summary?.elevatedModeConfirmed).toBe(false)

    const error = await runNowRejection(page, ELEVATED_ID)
    expect(error).toBeDefined()
    expect(error).toMatch(/elevated mode/i)

    // Rejection happens in main before the run host is asked to create a session.
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)
    expect(await page.evaluate(() => window.__E2E__!.getAcpAutomationRows())).toHaveLength(0)
  })

  test('invalid entries are listed with their errors and never run @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    // Missing `workspace` keeps this entry out of the runnable set.
    await writeTriggersConfig(page, [
      {
        id: INVALID_ID,
        name: 'Broken',
        source: { type: 'manual' },
        session: { prompt: 'Never runs' },
      },
    ])
    await waitForTriggerStatus(page, INVALID_ID, 'invalid')

    const summary = (await listTriggers(page)).find((trigger) => trigger.id === INVALID_ID)
    expect(summary?.sourceType).toBe('unknown')
    expect(summary?.errors?.length ?? 0).toBeGreaterThan(0)

    const error = await runNowRejection(page, INVALID_ID)
    expect(error).toBeDefined()
    expect(error).toMatch(/Invalid trigger configuration/i)
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)
  })
})
