/*---------------------------------------------------------------------------------------------
 *  Trigger Manager end-to-end: the command opens one singleton tab, the list
 *  reflects live main-process state, the row pause toggle drives setPaused, the
 *  configuration form writes through jsonc (comments survive) and invalidates the
 *  activation confirmation, the status-bar entry appears while something needs
 *  the user, and the run-history tab shows rows written at run end.
 *  The config lives in `<workspace>/.universe-editor/triggers.json`; most tests
 *  write it before running "Open Configuration", which registers the workspace.
 *  The rescan regression creates it after the window opened instead.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { E2ETriggerRunHistoryEntry, E2ETriggerSummary } from '@universe-editor/e2e-contract'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const MANAGER_COMMAND = 'workbench.action.triggers.openManager'
const CONFIG_ID = 'e2e-config'
const RUN_ID = 'e2e-run'

test.use({
  workspaceSeeder: {
    seed(dir: string) {
      writeFileSync(join(dir, 'README.md'), '# trigger manager e2e workspace\n')
    },
  },
})

function triggersConfigPath(workspace: string): string {
  return join(workspace, '.universe-editor', 'triggers.json')
}

function triggerEntry(id: string, name: string, prompt = 'Handle this E2E trigger event'): string {
  return `    {
      "id": "${id}",
      "name": "${name}",
      "enabled": false,
      "source": { "type": "manual" },
      "session": { "agent": "echo", "mode": "plan", "prompt": "${prompt}" },
      "concurrency": 1,
      "overflow": "queue"
    }`
}

/** Hand-written JSONC with comments the manager must preserve on a field write. */
function configWithComments(id: string, name: string, prompt?: string): string {
  return `// managed by the trigger manager e2e
{
  "version": 1,
  "triggers": [
    // keep this comment
${triggerEntry(id, name, prompt)}
  ]
}
`
}

async function registerConfig(page: Page, workspace: string, text: string): Promise<void> {
  const file = triggersConfigPath(workspace)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
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

async function installEchoAgent(page: Page): Promise<void> {
  await page.evaluate(
    ([agentId, jsPath]) =>
      window.__E2E__!.installAcpEchoAgent(agentId, jsPath, { ECHO_AGENT_CONFIG_OPTIONS: '1' }),
    ['echo', ECHO_AGENT_PATH] as const,
  )
}

async function openManager(page: Page): Promise<void> {
  await page.evaluate((command) => window.__E2E__!.runCommand(command), MANAGER_COMMAND)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
    .toBe('trigger.manager')
  await expect(page.getByTestId('trigger-manager')).toBeVisible()
}

test.describe('trigger manager', () => {
  test('opens one singleton tab and lists the workspace trigger @p1', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await registerConfig(page, launchWorkspace.dir, configWithComments(CONFIG_ID, 'Config Trigger'))
    await expect.poll(async () => (await findTrigger(page, CONFIG_ID))?.status).toBe('paused')

    await openManager(page)
    await expect(page.getByTestId('trigger-manager-row')).toHaveCount(1)
    await expect(page.getByTestId('trigger-manager-row')).toContainText('Config Trigger')

    const editors = await page.evaluate(() => window.__E2E__!.getActiveGroupEditorCount())
    await page.evaluate((command) => window.__E2E__!.runCommand(command), MANAGER_COMMAND)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveGroupEditorCount()))
      .toBe(editors)
    expect(await page.evaluate(() => window.__E2E__!.getActiveEditorUri())).toBe(
      'universe:/triggerManager',
    )
  })

  test('the row toggle resumes and pauses through setPaused @p1', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await registerConfig(page, launchWorkspace.dir, configWithComments(CONFIG_ID, 'Pause Trigger'))
    await expect.poll(async () => (await findTrigger(page, CONFIG_ID))?.status).toBe('paused')
    await openManager(page)

    // A first-seen trigger starts paused, so the toggle's first click resumes it.
    await page.getByTestId('trigger-manager-row-toggle').click()
    await expect.poll(async () => (await findTrigger(page, CONFIG_ID))?.paused).toBe(false)
    await expect
      .poll(async () => (await findTrigger(page, CONFIG_ID))?.status)
      .toBe('needs-confirmation')

    await page.getByTestId('trigger-manager-row-toggle').click()
    await expect.poll(async () => (await findTrigger(page, CONFIG_ID))?.paused).toBe(true)
    await expect.poll(async () => (await findTrigger(page, CONFIG_ID))?.status).toBe('paused')
  })

  test('the configuration form writes the field, keeps comments and invalidates confirmation @p1', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await registerConfig(page, launchWorkspace.dir, configWithComments(CONFIG_ID, 'Original Name'))
    const key = await triggerKey(page, CONFIG_ID)
    await page.evaluate((triggerKey) => window.__E2E__!.confirmTriggerActivation(triggerKey), key)
    await expect
      .poll(async () => (await findTrigger(page, CONFIG_ID))?.activationConfirmed)
      .toBe(true)
    // New triggers start paused; resume so the post-edit status is the gate, not the pause.
    await page.evaluate((triggerKey) => window.__E2E__!.setTriggerPaused(triggerKey, false), key)

    await openManager(page)
    await page.getByTestId('trigger-manager-tab-configuration').click()
    const name = page.getByTestId('trigger-manager-config-name')
    await expect(name).toHaveValue('Original Name')

    await name.fill('Renamed Trigger')
    const save = page.getByTestId('trigger-manager-config-save')
    await expect(save).toBeEnabled()
    await save.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Save' }).click()

    const file = triggersConfigPath(launchWorkspace.dir)
    await expect.poll(() => readFileSync(file, 'utf8')).toContain('"name": "Renamed Trigger"')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('// managed by the trigger manager e2e')
    expect(text).toContain('// keep this comment')

    // Any field edit invalidates the fingerprint-bound activation confirmation.
    await expect
      .poll(async () => (await findTrigger(page, CONFIG_ID))?.status)
      .toBe('needs-confirmation')
    expect((await findTrigger(page, CONFIG_ID))?.activationConfirmed).toBe(false)
  })

  test('the status-bar entry is always present and surfaces unconfirmed triggers @p1', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    const entry = page.getByTestId('statusbar-entry-triggers')
    // Permanent launcher: it exists before any trigger does.
    await expect(entry).toBeAttached({ timeout: 15_000 })
    await expect(entry).toHaveAttribute('data-tooltip', /No triggers/)

    await registerConfig(page, launchWorkspace.dir, configWithComments(CONFIG_ID, 'Status Trigger'))

    // One unconfirmed trigger → "$(zap) 1" with the breakdown in the tooltip.
    await expect(entry).toContainText('1')
    await expect(entry).toHaveAttribute('data-tooltip', /1 needs confirmation/)

    await entry.click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('trigger.manager')
  })

  test('the run-history tab lists a finished run @p1', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    await workbench.runCommand('workbench.trust.grant')
    await installEchoAgent(page)
    await registerConfig(
      page,
      launchWorkspace.dir,
      configWithComments(
        RUN_ID,
        'History Trigger',
        'Handle this E2E trigger event write-run-report',
      ),
    )
    const key = await triggerKey(page, RUN_ID)
    await page.evaluate((triggerKey) => window.__E2E__!.confirmTriggerActivation(triggerKey), key)
    await expect.poll(async () => (await findTrigger(page, RUN_ID))?.activationConfirmed).toBe(true)

    await page.evaluate((triggerKey) => window.__E2E__!.runTriggerNow(triggerKey), key)
    let runs: readonly E2ETriggerRunHistoryEntry[] = []
    await expect
      .poll(
        async () => {
          runs = await page.evaluate(
            (triggerKey) => window.__E2E__!.listTriggerRuns(triggerKey),
            key,
          )
          return runs.length
        },
        { timeout: 30_000 },
      )
      .toBe(1)
    expect(runs[0]?.outcome).toBe('completed')

    await openManager(page)
    await page.getByTestId('trigger-manager-tab-runs').click()
    await expect(page.getByTestId('trigger-manager-runs-row')).toHaveCount(1)
    await expect(page.getByTestId('trigger-manager-runs-row')).toContainText('Completed')
    await expect(page.getByTestId('trigger-manager-runs-row')).toContainText('Info')
    await expect(page.getByTestId('trigger-manager-runs-row')).toContainText('E2E trigger run')
  })

  test('restores search, selection, tab and run filter after reopening @p1', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    const config = `{
  "version": 1,
  "triggers": [
${triggerEntry('alpha', 'Alpha Trigger')},
${triggerEntry('beta', 'Beta Trigger')}
  ]
}
`
    await registerConfig(page, launchWorkspace.dir, config)
    await expect.poll(async () => (await findTrigger(page, 'alpha'))?.status).toBe('paused')

    await openManager(page)
    await expect(page.getByTestId('trigger-manager-row')).toHaveCount(2)

    await page.getByTestId('trigger-manager-search').fill('Beta')
    await expect(page.getByTestId('trigger-manager-row')).toHaveCount(1)
    await page.getByTestId('trigger-manager-row').click()
    await page.getByTestId('trigger-manager-tab-configuration').click()
    await expect(page.getByTestId('trigger-manager-config-name')).toHaveValue('Beta Trigger')
    // Let the debounced search write land before closing the tab.
    await page.waitForTimeout(400)

    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .not.toBe('trigger.manager')

    await openManager(page)
    await expect(page.getByTestId('trigger-manager-search')).toHaveValue('Beta')
    await expect(page.getByTestId('trigger-manager-row')).toHaveCount(1)
    await expect(page.getByTestId('trigger-manager-row')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('trigger-manager-tab-configuration')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByTestId('trigger-manager-config-name')).toHaveValue('Beta Trigger')

    await page.getByTestId('trigger-manager-tab-runs').click()
    await page.getByTestId('trigger-manager-runs-filter').click()
    await page.getByRole('option', { name: 'Failed' }).click()
    await expect(page.getByTestId('trigger-manager-runs-filter')).toContainText('Failed')

    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .not.toBe('trigger.manager')

    await openManager(page)
    await expect(page.getByTestId('trigger-manager-tab-runs')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByTestId('trigger-manager-runs-filter')).toContainText('Failed')
  })

  test('the empty state rescans a config added after the workspace opened @regression', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (launchWorkspace === undefined) throw new Error('workspaceSeeder must pin a workspace')
    await workbench.waitForRestored()
    const file = triggersConfigPath(launchWorkspace.dir)
    expect(existsSync(file)).toBe(false)

    await openManager(page)
    await expect(page.getByTestId('trigger-manager-empty')).toBeVisible()
    // Opening the manager is read-only: it must never create the config.
    expect(existsSync(file)).toBe(false)

    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, configWithComments(CONFIG_ID, 'Pulled Trigger'))
    await page.getByTestId('trigger-manager-rescan').click()

    await expect(page.getByTestId('trigger-manager-row')).toHaveCount(1)
    await expect(page.getByTestId('trigger-manager-row')).toContainText('Pulled Trigger')
    await expect.poll(async () => (await findTrigger(page, CONFIG_ID))?.status).toBe('paused')
    expect((await findTrigger(page, CONFIG_ID))?.activationConfirmed).toBe(false)

    // Repeat opens reuse the tab and keep the list free of duplicates.
    await page.evaluate((command) => window.__E2E__!.runCommand(command), MANAGER_COMMAND)
    await expect(page.getByTestId('trigger-manager-row')).toHaveCount(1)
  })
})
