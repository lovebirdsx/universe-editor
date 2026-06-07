/*---------------------------------------------------------------------------------------------
 *  Editor state restore smoke test (@p1).
 *
 *  验证：
 *   1. 工作区下打开的文件在重启后能恢复（workspace 级状态）
 *   2. 切换到另一个工作区时，前一个工作区的 tab 不会泄漏（scope 隔离）
 *
 *  实现：直接预写入 userData 目录下的 workspaces/<hash>.json + state.json
 *  （current workspace 指针），绕开 persist 步骤。
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, APP_ROOT } from '../fixtures/electronApp.js'

/** Convert a filesystem path to the UriComponents format used by URI.file(). */
function fsPathToUriComponents(fsPath: string) {
  const forwardSlash = fsPath.replace(/\\/g, '/')
  const path = forwardSlash.startsWith('/') ? forwardSlash : '/' + forwardSlash
  return { scheme: 'file', authority: '', path, query: '', fragment: '' }
}

/** Stable workspace id — must mirror main/storage.ts:workspaceIdFromUri. */
function workspaceIdFromFolder(folderFsPath: string): string {
  // URI.file(folder).toString() shape: file:///<path>
  const path = folderFsPath.replace(/\\/g, '/')
  const uriString = 'file://' + (path.startsWith('/') ? path : '/' + path)
  return createHash('sha1').update(uriString).digest('hex').slice(0, 16)
}

function buildWorkspaceState(filePath: string) {
  return {
    grid: {
      root: {
        type: 'branch',
        size: 1,
        children: [
          {
            type: 'leaf',
            size: 1,
            data: {
              editors: [
                {
                  typeId: 'file',
                  data: { resource: fsPathToUriComponents(filePath) },
                },
              ],
              activeIndex: 0,
            },
          },
        ],
      },
      orientation: 0,
      width: 800,
      height: 600,
    },
    activeGroupId: 0,
  }
}

/** Seed a workspace's state file under <userData>/workspaces/<hash>.json. */
function seedWorkspaceFile(userDataDir: string, folder: string, openFile: string): void {
  const hash = workspaceIdFromFolder(folder)
  const wsDir = join(userDataDir, 'workspaces')
  mkdirSync(wsDir, { recursive: true })
  const payload = { 'workbench.workspaceState': { groups: buildWorkspaceState(openFile) } }
  writeFileSync(join(wsDir, `${hash}.json`), JSON.stringify(payload, null, 2))
}

/** Seed state.json so the app restores a single window into `folder`. */
function seedGlobalSession(userDataDir: string, folder: string): void {
  const folderComponents = fsPathToUriComponents(folder)
  const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
  const payload = {
    'workbench.windowsState': [
      { workspace: { folder: folderComponents, name }, uiState: null, devToolsOpen: false },
    ],
    'workbench.recentWorkspaces': [{ folder: folderComponents, name, lastOpened: Date.now() }],
  }
  writeFileSync(join(userDataDir, 'state.json'), JSON.stringify(payload, null, 2))
}

async function launchWithState(userDataDir: string) {
  // ELECTRON_RUN_AS_NODE=1 (set by Claude Code's shell) makes Electron behave as
  // plain Node.js, which rejects Chromium-only flags. Unset it so the binary runs
  // as a full Chromium app (mirrors the shared electronApp fixture).
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.evaluate(() => window.__E2E__!.whenRestored())
      break
    } catch (err) {
      if (attempt === 1 || !/Execution context was destroyed/.test(String(err))) throw err
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
    }
  }
  return { app, page }
}

test.describe('@p1 editor restore', () => {
  test('file editor is restored from workspace state after restart', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-editor-restore-'))
    try {
      const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-'))
      const testFile = join(workspaceFolder, 'hello.json')
      writeFileSync(testFile, '{ "restored": true }')

      seedGlobalSession(userDataDir, workspaceFolder)
      seedWorkspaceFile(userDataDir, workspaceFolder, testFile)

      const { app, page } = await launchWithState(userDataDir)
      try {
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
            timeout: 5000,
          })
          .toContain('hello.json')
      } finally {
        await app.close()
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
        /* noop — temp dir cleanup is best-effort */
      }
    }
  })

  test('switching workspaces does not leak editors across scopes', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-editor-restore-iso-'))
    try {
      // Workspace A has an open editor; workspace B is empty.
      const wsA = mkdtempSync(join(tmpdir(), 'universe-editor-wsA-'))
      const wsB = mkdtempSync(join(tmpdir(), 'universe-editor-wsB-'))
      const fileA = join(wsA, 'a.json')
      writeFileSync(fileA, '{}')

      // Boot directly into A.
      seedGlobalSession(userDataDir, wsA)
      seedWorkspaceFile(userDataDir, wsA, fileA)

      const { app, page } = await launchWithState(userDataDir)
      try {
        // A: should restore the seeded file.
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
            timeout: 5000,
          })
          .toContain('a.json')

        // Switch to B (no seeded state) — A's tab should disappear.
        await page.evaluate((folderPath) => window.__E2E__!.openWorkspace(folderPath), wsB)
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
            timeout: 5000,
          })
          .toBeFalsy()

        // Switch back to A — its tab should restore.
        await page.evaluate((folderPath) => window.__E2E__!.openWorkspace(folderPath), wsA)
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
            timeout: 5000,
          })
          .toContain('a.json')
      } finally {
        await app.close()
      }
      for (const dir of [wsA, wsB]) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        } catch {
          /* best-effort */
        }
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
