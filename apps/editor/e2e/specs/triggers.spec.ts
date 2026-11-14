/*---------------------------------------------------------------------------------------------
 *  Agent triggers end-to-end: workspace-scoped definitions, the per-machine activation
 *  gate, the main-process scheduler accepting a manual event, the owning window
 *  creating an unattended (inactive) session, the rendered prompt carrying its
 *  untrusted-data fence into durable history, and the elevated-mode confirmation.
 *  The config lives in `<workspace>/.universe-editor/triggers.json`; the spec writes
 *  it before running "Open Configuration", which registers the workspace.
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
const INVALID_ID = 'Bad Id'

test.use({
  workspaceSeeder: {
    seed(dir: string) {
      writeFileSync(join(dir, 'README.md'), '# trigger e2e workspace\n')
    },
  },
})

function triggersConfigPath(workspace: string): string {
  return join(workspace, '.universe-editor', 'triggers.json')
}

/** Write the workspace trigger file, then register it through the real command. */
async function writeTriggersConfig(
  page: Page,
  workspace: string,
  triggers: readonly unknown[],
): Promise<void> {
  const file = triggersConfigPath(workspace)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, triggers }, null, 2))
  await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.triggers.openConfig'))
}

async function listTriggers(page: Page): Promise<readonly E2ETriggerSummary[]> {
  return page.evaluate(() => window.__E2E__!.listTriggers())
}

async function findTrigger(page: Page, id: string): Promise<E2ETriggerSummary | undefined> {
  return (await listTriggers(page)).find((trigger) => trigger.id === id)
}

async function triggerKey(page: Page, id: string): Promise<string> {
  const summary = await findTrigger(page, id)
  if (summary === undefined) throw new Error(`trigger ${id} is not listed`)
  return summary.key
}

async function waitForTriggerStatus(page: Page, id: string, status: string): Promise<void> {
  await expect
    .poll(async () => (await findTrigger(page, id))?.status, { timeout: 15_000 })
    .toBe(status)
}

async function waitForActivationConfirmed(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => (await findTrigger(page, id))?.activationConfirmed, { timeout: 15_000 })
    .toBe(true)
}

/** configOptions on: the run verifies the pinned mode landed before prompting. */
async function installEchoAgent(page: Page): Promise<void> {
  await page.evaluate(
    ([agentId, jsPath]) =>
      window.__E2E__!.installAcpEchoAgent(agentId, jsPath, { ECHO_AGENT_CONFIG_OPTIONS: '1' }),
    ['echo', ECHO_AGENT_PATH] as const,
  )
}

function manualTrigger(id: string = MANUAL_ID): Record<string, unknown> {
  return {
    id,
    name: 'E2E Manual Trigger',
    enabled: false,
    source: { type: 'manual' },
    // An unknown agent has no conservative default, so the mode must be explicit.
    session: { agent: 'echo', mode: 'plan', prompt: 'Handle this E2E trigger event' },
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

function runNowRejection(page: Page, key: string): Promise<string | undefined> {
  return page.evaluate(async (triggerKey) => {
    try {
      await window.__E2E__!.runTriggerNow(triggerKey)
      return undefined
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }, key)
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

  test('a workspace trigger cannot run until it is confirmed on this machine @p0', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await workbench.runCommand('workbench.trust.grant')
    await installEchoAgent(page)
    await writeTriggersConfig(page, launchWorkspace.dir, [manualTrigger()])
    await waitForTriggerStatus(page, MANUAL_ID, 'needs-confirmation')

    const summary = await findTrigger(page, MANUAL_ID)
    expect(summary?.workspace).toBeTruthy()
    expect(summary?.workspaceName).toBeTruthy()
    expect(summary?.activationConfirmed).toBe(false)

    // The activation gate rejects before the run host is asked for a session, and a
    // poll command never runs either — nothing was fetched or started.
    const rejection = await runNowRejection(page, summary!.key)
    expect(rejection).toBeDefined()
    expect(rejection).toMatch(/confirm this trigger/i)
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)
    expect(await page.evaluate(() => window.__E2E__!.getAcpAutomationRows())).toHaveLength(0)
  })

  test('a confirmed manual trigger starts an inactive session whose first prompt carries the task and empty-event notice @p0', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await workbench.runCommand('workbench.trust.grant')
    await installEchoAgent(page)
    await writeTriggersConfig(page, launchWorkspace.dir, [manualTrigger()])
    await waitForTriggerStatus(page, MANUAL_ID, 'needs-confirmation')

    const key = await triggerKey(page, MANUAL_ID)
    await page.evaluate((triggerKey) => window.__E2E__!.confirmTriggerActivation(triggerKey), key)
    await waitForActivationConfirmed(page, MANUAL_ID)
    await waitForTriggerStatus(page, MANUAL_ID, 'disabled')

    const editorsBefore = await page.evaluate(() => window.__E2E__!.getActiveGroupEditorCount())
    await page.evaluate((triggerKey) => window.__E2E__!.runTriggerNow(triggerKey), key)

    await expect
      .poll(
        async () =>
          (await activeAutomationRow(page, MANUAL_ID))?.firstPrompt?.includes('本次无外部事件数据'),
        { timeout: 30_000 },
      )
      .toBe(true)

    const row = await activeAutomationRow(page, MANUAL_ID)
    expect(row).toBeDefined()
    expect(row!.automation.triggerName).toBe('E2E Manual Trigger')
    expect(row!.automation.workspaceName).toBeTruthy()
    expect(row!.automation.eventKey).toMatch(/^manual:/)
    expect(row!.automation.runId.length).toBeGreaterThan(0)
    expect(row!.agentId).toBe('echo')

    const prompt = row!.firstPrompt!
    expect(prompt).toContain('## 任务\nHandle this E2E trigger event')
    expect(prompt).toContain('## 输出要求（始终生效，优先于任务描述）')
    expect(prompt).toContain('verdict（auto-approve | escalate | reject | info）')
    expect(prompt.match(/运行目录：/g)).toHaveLength(1)
    expect(prompt).toContain('## 事件数据\n本次无外部事件数据。')
    expect(prompt).not.toContain('<event-data')
    expect(prompt).not.toContain('不可信数据')

    // activate:false — the session is registered but stays out of the editor area.
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(1)
    expect(await page.evaluate(() => window.__E2E__!.getAcpHistoryCount())).toBe(1)
    expect(await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())).toBeUndefined()
    expect(await page.evaluate(() => window.__E2E__!.getActiveGroupEditorCount())).toBe(
      editorsBefore,
    )

    // The report tab reads this run's report.md by run id; the renderer never
    // receives a path. Write the report where the run directory lives.
    const runsDir = await page.evaluate(() => window.__E2E__!.getTriggersRunsDir())
    const runDir = join(runsDir, row!.automation.runId)
    mkdirSync(runDir, { recursive: true })

    // The echo agent is unknown to the capability table, so the contract stays
    // inline and the audit copy records that no system prompt append was used.
    const audit = await page.evaluate(
      (path) => window.__E2E__!.readWorkspaceFileText(path),
      join(runDir, 'prompt.md'),
    )
    expect(audit).toContain('## System prompt append\n未使用（输出契约已内联到首条消息）')
    expect(audit).toContain('## 首条用户消息')
    expect(audit).toContain(prompt)
    writeFileSync(join(runDir, 'report.md'), '# E2E run report\n\nReport body.\n')
    await workbench.runCommand('workbench.action.triggers.viewReport', {
      sessionId: row!.sessionId,
      runId: row!.automation.runId,
      triggerName: row!.automation.triggerName,
      eventKey: row!.automation.eventKey,
    })
    await expect
      .poll(() => workbench.getActiveEditorUri())
      .toBe(`trigger-report:${row!.automation.runId}`)
    expect(await page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())).toBe(
      'trigger.report',
    )
  })

  test('an elevated mode is refused until the user confirms it @p0', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await workbench.runCommand('workbench.trust.grant')
    await installEchoAgent(page)
    await writeTriggersConfig(page, launchWorkspace.dir, [
      {
        ...manualTrigger(ELEVATED_ID),
        session: {
          agent: 'echo',
          mode: 'bypassPermissions',
          prompt: 'Elevated run',
        },
      },
    ])
    await waitForTriggerStatus(page, ELEVATED_ID, 'needs-confirmation')

    // Confirming the workspace trigger does not pre-approve its bypass-class mode.
    const key = await triggerKey(page, ELEVATED_ID)
    await page.evaluate((triggerKey) => window.__E2E__!.confirmTriggerActivation(triggerKey), key)
    await waitForActivationConfirmed(page, ELEVATED_ID)

    const summary = await findTrigger(page, ELEVATED_ID)
    expect(summary?.elevatedMode).toBe(true)
    expect(summary?.elevatedModeConfirmed).toBe(false)
    expect(summary?.status).toBe('needs-confirmation')

    const error = await runNowRejection(page, key)
    expect(error).toBeDefined()
    expect(error).toMatch(/elevated mode/i)

    // Rejection happens in main before the run host is asked to create a session.
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)
    expect(await page.evaluate(() => window.__E2E__!.getAcpAutomationRows())).toHaveLength(0)
  })

  test('a paused trigger refuses runNow and creates no session @p0', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await installEchoAgent(page)
    await writeTriggersConfig(page, launchWorkspace.dir, [manualTrigger()])
    await waitForTriggerStatus(page, MANUAL_ID, 'needs-confirmation')

    const key = await triggerKey(page, MANUAL_ID)
    await page.evaluate((triggerKey) => window.__E2E__!.confirmTriggerActivation(triggerKey), key)
    await waitForActivationConfirmed(page, MANUAL_ID)
    await waitForTriggerStatus(page, MANUAL_ID, 'disabled')

    await page.evaluate((triggerKey) => window.__E2E__!.setTriggerPaused(triggerKey, true), key)
    await waitForTriggerStatus(page, MANUAL_ID, 'paused')

    const error = await runNowRejection(page, key)
    expect(error).toBeDefined()
    expect(error).toMatch(/paused/i)

    // The pause gate rejects before the run host is asked to create a session.
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)
    expect(await page.evaluate(() => window.__E2E__!.getAcpAutomationRows())).toHaveLength(0)

    // Resuming clears the pause; the trigger is runnable again (still disabled as configured).
    await page.evaluate((triggerKey) => window.__E2E__!.setTriggerPaused(triggerKey, false), key)
    await waitForTriggerStatus(page, MANUAL_ID, 'disabled')
  })

  test('invalid entries are listed with their errors and never run @regression', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    // A session without skill or prompt keeps this entry out of the runnable set.
    await writeTriggersConfig(page, launchWorkspace.dir, [
      {
        id: INVALID_ID,
        name: 'Broken',
        source: { type: 'manual' },
        session: {},
      },
    ])
    await waitForTriggerStatus(page, INVALID_ID, 'invalid')

    const summary = await findTrigger(page, INVALID_ID)
    expect(summary?.sourceType).toBe('unknown')
    expect(summary?.errors?.length ?? 0).toBeGreaterThan(0)

    const error = await runNowRejection(page, summary!.key)
    expect(error).toBeDefined()
    expect(error).toMatch(/Invalid trigger configuration/i)
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)
  })
})
