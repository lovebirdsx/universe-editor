/*---------------------------------------------------------------------------------------------
 *  Remote agent triggers (@regression).
 *
 *  Opens a `remote-ssh://` folder as the workspace with a workspace-defined
 *  trigger, then proves the whole run happens on the remote host.
 *
 *  Manual scenario:
 *    - the scheduler lists the definition under the remote-ssh workspace URI;
 *    - the automated session records authority `e2e-local` and the remote
 *      workspace root as its cwd;
 *    - the echo agent writes result.json / report.md into the run directory from
 *      the prompt (the directory exists on the remote host), and the report is
 *      read back through the trigger service's remote path;
 *    - the run directory lives under the direct-mode server's
 *      `<dataDir>/triggers/runs/<clientId>/` tree.
 *
 *  Poll scenario: a real `node poll.js` command runs on the remote host through
 *  the remote `triggerPoll` channel (baseline + a second interval that starts a
 *  run), and an untrusted workspace never spawns it at all.
 *
 *  Direct mode, same as remote.acp / remote.workspaceUi:
 *  UNIVERSE_REMOTE_SERVER_CMD runs the local daemon against the Playwright tmp dir
 *  with authority `e2e-local`.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    concurrency: 1,
    overflow: 'queue',
  }
}

/** Each poll invocation emits a new key and leaves a marker in the workspace. */
function pollScript(): string {
  return [
    "const fs = require('node:fs')",
    'let count = 0',
    "try { count = Number(fs.readFileSync('poll-count.txt', 'utf8')) || 0 } catch {}",
    'count += 1',
    "fs.writeFileSync('poll-count.txt', String(count))",
    "fs.appendFileSync('poll-runs.txt', count + '\\n')",
    "process.stdout.write(JSON.stringify([{ id: 'poll-' + count, title: 'Remote poll item ' + count }]))",
    '',
  ].join('\n')
}

/** The remote daemon spawns through a shell; quote a path that may contain spaces. */
function nodeCommand(script: string): string {
  return `"${process.execPath}" ${script}`
}

function pollTrigger(): Record<string, unknown> {
  return {
    id: 'e2e-remote-poll',
    name: 'E2E Remote Poll Trigger',
    enabled: true,
    source: {
      type: 'poll',
      intervalSec: 30,
      keyField: 'id',
      fetch: { type: 'command', command: nodeCommand('poll.js'), timeoutSec: 20 },
    },
    session: { agent: 'echo', mode: 'plan', prompt: 'write-run-report' },
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

    // First seen on this machine → paused; confirmation is still required.
    await expect
      .poll(async () => (await listTriggers(page))[0]?.status, { timeout: 20_000 })
      .toBe('paused')
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

  test('a poll trigger executes its command on the remote host and starts a run @regression', async ({
    workbench,
    scratchDir,
  }) => {
    // The scheduler's startup gate is 60s and poll `intervalSec` has a 30s
    // minimum, so the second (run-producing) poll lands ~90s after boot.
    test.setTimeout(300_000)
    await workbench.waitForRestored()
    const page = workbench.page
    const workspaceDir = scratchDir('ue2-remote-poll-')
    const configDir = join(workspaceDir, '.universe-editor')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(workspaceDir, 'poll.js'), pollScript())
    writeFileSync(
      join(configDir, 'triggers.json'),
      JSON.stringify({ version: 1, triggers: [pollTrigger()] }, null, 2),
    )

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
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.triggers.openConfig'))

    // First seen on this machine → paused; confirmation is still required.
    await expect
      .poll(async () => (await listTriggers(page)).find((t) => t.workspace === rootUri)?.status, {
        timeout: 20_000,
      })
      .toBe('paused')
    const summary = (await listTriggers(page)).find((t) => t.workspace === rootUri)
    expect(summary?.sourceType).toBe('poll')
    const key = summary!.key
    await page.evaluate((triggerKey) => window.__E2E__!.confirmTriggerActivation(triggerKey), key)
    // First sighting starts paused; resuming lets the scheduler poll.
    await page.evaluate((triggerKey) => window.__E2E__!.setTriggerPaused(triggerKey, false), key)

    // The first poll (after the startup gate) seeds the baseline; the next one,
    // one interval later, emits a fresh key and starts a real run.
    const countFile = join(workspaceDir, 'poll-count.txt')
    await expect.poll(() => existsSync(countFile), { timeout: 120_000 }).toBe(true)

    const automationRow = async (): Promise<E2ETriggerAutomationRow | undefined> =>
      (await page.evaluate(() => window.__E2E__!.getAcpAutomationRows())).find(
        (row) => row.automation.triggerId === 'e2e-remote-poll',
      )
    await expect
      .poll(async () => (await automationRow())?.automation.outcome, { timeout: 120_000 })
      .toBe('completed')

    // Baseline + at least one more interval: the command really repeats remotely.
    expect(Number(readFileSync(countFile, 'utf8'))).toBeGreaterThanOrEqual(2)

    const row = await automationRow()
    expect(row).toBeDefined()
    expect(row!.agentId).toBe('echo')
    expect(row!.authority).toBe(AUTHORITY)
    expect(row!.automation.eventKey).toMatch(/^poll:poll-\d+$/)
    expect(normalizeFsPath(row!.cwd ?? '')).toBe(normalizeFsPath(URI.parse(rootUri).fsPath))

    const report = await page.evaluate(
      ([runId, authority]) => window.__E2E__!.readTriggerRunReport(runId, authority),
      [row!.automation.runId, AUTHORITY] as const,
    )
    if (report.kind !== 'ok') throw new Error(`report read failed: ${report.kind}`)
    expect(report.text).toContain('# E2E trigger run report')

    const runDir = URI.parse(report.runDir)
    expect(runDir.scheme).toBe('remote-ssh')
    expect(runDir.authority).toBe(AUTHORITY)
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
  })

  test('an untrusted remote workspace never executes the poll command @regression', async ({
    workbench,
    scratchDir,
  }) => {
    test.setTimeout(300_000)
    await workbench.waitForRestored()
    const page = workbench.page
    const workspaceDir = scratchDir('ue2-remote-poll-untrusted-')
    const configDir = join(workspaceDir, '.universe-editor')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(workspaceDir, 'poll.js'), pollScript())
    writeFileSync(
      join(configDir, 'triggers.json'),
      JSON.stringify({ version: 1, triggers: [pollTrigger()] }, null, 2),
    )

    const rootUri = remoteUri(workspaceDir)
    await page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)
    // Deliberately no `workbench.trust.grant`: this workspace stays restricted.
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.triggers.openConfig'))

    await expect
      .poll(async () => (await listTriggers(page)).find((t) => t.workspace === rootUri)?.status, {
        timeout: 20_000,
      })
      .toBe('paused')
    const key = (await listTriggers(page)).find((t) => t.workspace === rootUri)!.key
    await page.evaluate((triggerKey) => window.__E2E__!.confirmTriggerActivation(triggerKey), key)
    await page.evaluate((triggerKey) => window.__E2E__!.setTriggerPaused(triggerKey, false), key)

    // Confirm activation does not imply trust. Wait past the 60s scheduling gate
    // plus the first poll slot: a missing trust check would have written the
    // markers long before this point.
    await page.waitForTimeout(75_000)
    expect(existsSync(join(workspaceDir, 'poll-count.txt'))).toBe(false)
    expect(existsSync(join(workspaceDir, 'poll-runs.txt'))).toBe(false)
    expect(await page.evaluate(() => window.__E2E__!.getAcpAutomationRows())).toHaveLength(0)
  })
})
