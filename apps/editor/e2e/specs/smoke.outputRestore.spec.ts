/*---------------------------------------------------------------------------------------------
 *  Output channel restore smoke test (@p1).
 *
 *  验证：
 *   1. 稳定频道名（如 "Universe Editor"）在重启后能被恢复
 *   2. ACP 动态频道名（acp/<agentId>/<handle>）在 handle 变化后，仍能按
 *      前两段前缀（acp/<agentId>/）匹配到新频道并激活
 *
 *  实现：预写入 workspaces/<hash>.json 的 output.activeChannel 键，绕开 UI
 *  操作步骤，直接测试重启后的恢复逻辑。
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, APP_ROOT, closeApp } from '../fixtures/electronApp.js'
import { expectNoLeaks, evaluateWhenRestored } from '../pages/WorkbenchPO.js'

function seedUserSettings(userDataDir: string): void {
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ 'workbench.language': 'en-US', 'update.mode': 'manual' }, null, 2),
    'utf8',
  )
}

function fsPathToUriComponents(fsPath: string) {
  const forwardSlash = fsPath.replace(/\\/g, '/')
  const path = forwardSlash.startsWith('/') ? forwardSlash : '/' + forwardSlash
  return { scheme: 'file', authority: '', path, query: '', fragment: '' }
}

function workspaceIdFromFolder(folderFsPath: string): string {
  const path = folderFsPath.replace(/\\/g, '/')
  const uriString = 'file://' + (path.startsWith('/') ? path : '/' + path)
  return createHash('sha1').update(uriString).digest('hex').slice(0, 16)
}

/** Seed state.json so the app restores a single window into `folder`. */
function seedGlobalState(userDataDir: string, folder: string): void {
  const folderComponents = fsPathToUriComponents(folder)
  const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify(
      {
        'workbench.windowsState': [
          { workspace: { folder: folderComponents, name }, uiState: null, devToolsOpen: false },
        ],
        'workbench.recentWorkspaces': [{ folder: folderComponents, name, lastOpened: Date.now() }],
      },
      null,
      2,
    ),
  )
}

/** Write (or merge into) workspaces/<hash>.json with the given key/value. */
function seedWorkspaceKey(userDataDir: string, folder: string, key: string, value: unknown): void {
  const hash = workspaceIdFromFolder(folder)
  const wsDir = join(userDataDir, 'workspaces')
  mkdirSync(wsDir, { recursive: true })
  const wsFile = join(wsDir, `${hash}.json`)
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(wsFile, 'utf8')) as Record<string, unknown>
  } catch {
    /* file may not exist yet */
  }
  existing[key] = value
  writeFileSync(wsFile, JSON.stringify(existing, null, 2))
}

async function launchWithState(userDataDir: string) {
  seedUserSettings(userDataDir)
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: { ...inheritedEnv, UNIVERSE_E2E: '1', NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production' },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
  await evaluateWhenRestored(page)
  return { app, page }
}

test.describe('@p1 output channel restore', () => {
  test('stable channel is restored from workspace state after restart', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-output-restore-'))
    try {
      const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-out-'))

      // Pre-seed: boot into the workspace and restore "Main" channel.
      // Main is chosen because the main process always writes startup
      // logs, so the file is guaranteed to exist after bootstrap — meaning
      // LogTailContribution pre-creates the channel and the OutputService
      // pending-restore can activate it.
      seedGlobalState(userDataDir, workspaceFolder)
      seedWorkspaceKey(userDataDir, workspaceFolder, 'output.activeChannel', 'Main')

      const { app, page } = await launchWithState(userDataDir)
      try {
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveOutputChannelName()), {
            timeout: 5000,
          })
          .toBe('Main')
        await expectNoLeaks(page)
      } finally {
        await closeApp(app)
      }
      try {
        rmSync(workspaceFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* best-effort */
      }
    } finally {
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* noop */
      }
    }
  })

  test('deferred stable channel is activated once created', async () => {
    // "TestChannel" does not exist at startup; it is created via probe after
    // the workbench mounts.  The pending-restore path should pick it up.
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-output-deferred-'))
    try {
      const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-deferred-'))

      seedGlobalState(userDataDir, workspaceFolder)
      seedWorkspaceKey(userDataDir, workspaceFolder, 'output.activeChannel', 'TestChannel')

      const { app, page } = await launchWithState(userDataDir)
      try {
        // Initially falls back to the default "All".
        const initial = await page.evaluate(() => window.__E2E__!.getActiveOutputChannelName())
        expect(initial).toBe('All')

        // Creating "TestChannel" should trigger the pending restore activation.
        await page.evaluate(() => window.__E2E__!.createOutputChannel('TestChannel'))

        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveOutputChannelName()), {
            timeout: 3000,
          })
          .toBe('TestChannel')
        await expectNoLeaks(page)
      } finally {
        await closeApp(app)
      }
      try {
        rmSync(workspaceFolder, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        })
      } catch {
        /* best-effort */
      }
    } finally {
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* noop */
      }
    }
  })

  test('ACP channel is restored after handle rotation', async () => {
    // Simulates the case where the user had acp/claude/old-handle active.
    // On restart the ACP service creates acp/claude/new-handle.
    // The prefix-matching fix should activate the new channel automatically.
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-output-acp-'))
    try {
      const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-acp-'))

      seedGlobalState(userDataDir, workspaceFolder)
      seedWorkspaceKey(
        userDataDir,
        workspaceFolder,
        'output.activeChannel',
        'acp/claude/old-handle',
      )

      const { app, page } = await launchWithState(userDataDir)
      try {
        // Initially "All" because "acp/claude/old-handle" doesn't exist.
        const initial = await page.evaluate(() => window.__E2E__!.getActiveOutputChannelName())
        expect(initial).toBe('All')

        // ACP service reconnects and creates a channel with a NEW handle.
        await page.evaluate(() => window.__E2E__!.createOutputChannel('acp/claude/new-handle'))

        // The prefix-matching fix should activate "acp/claude/new-handle".
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveOutputChannelName()), {
            timeout: 3000,
          })
          .toBe('acp/claude/new-handle')
        await expectNoLeaks(page)
      } finally {
        await closeApp(app)
      }
      try {
        rmSync(workspaceFolder, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        })
      } catch {
        /* best-effort */
      }
    } finally {
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* noop */
      }
    }
  })
})
