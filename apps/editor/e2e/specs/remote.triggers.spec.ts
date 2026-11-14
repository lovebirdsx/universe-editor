/*---------------------------------------------------------------------------------------------
 *  Remote agent triggers (@regression).
 *
 *  Opens a `remote-ssh://` folder as the workspace with a workspace-defined manual
 *  trigger, then proves the whole run happens on the remote host:
 *
 *    - the scheduler lists the definition under the remote-ssh workspace URI;
 *    - the automated session records authority `e2e-local` and the remote
 *      workspace root as its cwd;
 *    - the echo agent writes result.json / report.md into the run directory from
 *      the prompt (the directory exists on the remote host), and the report is
 *      read back through the trigger service's remote path;
 *    - the run directory lives under the direct-mode server's
 *      `<dataDir>/triggers/runs/<clientId>/` tree.
 *
 *  Direct mode, same as remote.acp / remote.workspaceUi:
 *  UNIVERSE_REMOTE_SERVER_CMD runs the local daemon against the Playwright tmp dir
 *  with authority `e2e-local`.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { E2ETriggerAutomationRow, E2ETriggerSummary } from '@universe-editor/e2e-contract'
import {
  normalizeFsPath,
  normalizePlatform,
  relativePathUnder,
  URI,
} from '@universe-editor/platform'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'

const AUTHORITY = 'e2e-local'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const remoteServerEntry = path.join(repoRoot, 'packages', 'remote-server', 'dist', 'bootstrap.js')

export const test = createColdAppTest({
  appRoot: path.resolve(import.meta.dirname, '..', '..'),
  mainEntry: path.resolve(import.meta.dirname, '..', '..', 'out', 'main', 'index.js'),
  extensions: [],
  env: {
    UNIVERSE_REMOTE_SERVER_CMD: JSON.stringify([process.execPath, remoteServerEntry]),
  },
})

/** `remote-ssh://<authority>/<path>` for an absolute local path (same host). */
function remoteUri(fsPath: string): string {
  const normalized = fsPath.replace(/\\/g, '/')
  const pathPart = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `remote-ssh://${AUTHORITY}${pathPart}`
}

function manualTrigger(): Record<string, unknown> {
  return {
    id: 'e2e-remote-manual',
    name: 'E2E Remote Manual Trigger',
    enabled: false,
    source: { type: 'manual' },
    session: { agent: 'echo', mode: 'plan', prompt: 'write-run-report' },
    allowedActions: [],
    concurrency: 1,
    overflow: 'queue',
  }
}

async function listTriggers(page: Page): Promise<readonly E2ETriggerSummary[]> {
  return page.evaluate(() => window.__E2E__!.listTriggers())
}

test.describe('remote agent triggers', () => {
  test('a manual trigger runs on the remote host and its report is readable @regression', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const page = workbench.page
    const workspaceDir = scratchDir('ue2-remote-triggers-')

    // Write the definition before opening the folder: discovery runs when the
    // window opens a folder that already contains triggers.json.
    const configDir = join(workspaceDir, '.universe-editor')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'triggers.json'),
      JSON.stringify({ version: 1, triggers: [manualTrigger()] }, null, 2),
    )
    writeFileSync(join(workspaceDir, 'README.md'), '# remote trigger e2e workspace\n')

    const rootUri = remoteUri(workspaceDir)
    await page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)

    await workbench.runCommand('workbench.trust.grant')
    await page.evaluate(
      ([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p, { ECHO_AGENT_CONFIG_OPTIONS: '1' }),
      ['echo', ECHO_AGENT_PATH] as const,
    )
    // Register the workspace through the same entry the command uses (the file
    // already exists, so this only adds it to the registry).
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.triggers.openConfig'))

    await expect
      .poll(async () => (await listTriggers(page))[0]?.status, { timeout: 20_000 })
      .toBe('needs-confirmation')
    const summary = (await listTriggers(page))[0]
    expect(summary?.workspace).toBe(rootUri)
    expect(summary?.workspace.startsWith('remote-ssh:')).toBe(true)
    expect(summary?.activationConfirmed).toBe(false)

    const key = summary!.key
    await page.evaluate((triggerKey) => window.__E2E__!.confirmTriggerActivation(triggerKey), key)
    await expect
      .poll(async () => (await listTriggers(page))[0]?.activationConfirmed, { timeout: 15_000 })
      .toBe(true)

    await page.evaluate((triggerKey) => window.__E2E__!.runTriggerNow(triggerKey), key)

    const automationRow = async (): Promise<E2ETriggerAutomationRow | undefined> => {
      const rows = await page.evaluate(() => window.__E2E__!.getAcpAutomationRows())
      return rows[0]
    }
    await expect
      .poll(async () => (await automationRow())?.automation.outcome, { timeout: 60_000 })
      .toBe('completed')

    const row = await automationRow()
    expect(row).toBeDefined()
    expect(row!.agentId).toBe('echo')
    expect(row!.authority).toBe(AUTHORITY)
    // The agent was spawned with the remote workspace root as its cwd.
    expect(normalizeFsPath(row!.cwd ?? '')).toBe(normalizeFsPath(URI.parse(rootUri).fsPath))
    expect(row!.automation.triggerName).toBe('E2E Remote Manual Trigger')
    expect(row!.automation.runId.length).toBeGreaterThan(0)

    // Read the report through the trigger service; main routes it to the remote
    // host instead of looking in the local runs directory.
    const report = await page.evaluate(
      ([runId, authority]) => window.__E2E__!.readTriggerRunReport(runId, authority),
      [row!.automation.runId, AUTHORITY] as const,
    )
    if (report.kind !== 'ok') throw new Error(`report read failed: ${report.kind}`)
    expect(report.text).toContain('# E2E trigger run report')

    const runDir = URI.parse(report.runDir)
    expect(runDir.scheme).toBe('remote-ssh')
    expect(runDir.authority).toBe(AUTHORITY)

    // Direct mode puts the server data dir at `<userData>/remote-direct/<authority>`;
    // the local runs dir is `<userData>/triggers/runs`.
    const localRunsDir = await page.evaluate(() => window.__E2E__!.getTriggersRunsDir())
    const remoteRunsRoot = join(
      dirname(dirname(localRunsDir)),
      'remote-direct',
      AUTHORITY,
      'triggers',
      'runs',
    )
    expect(
      relativePathUnder(remoteRunsRoot, runDir.fsPath, normalizePlatform(process.platform)),
    ).not.toBeNull()

    // A dropped socket must not take the window (or the scheduler) down.
    await page.evaluate((authority) => window.__E2E__!.dropRemoteSocket(authority), AUTHORITY)
    expect(await page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri())).toBe(rootUri)
  })
})
