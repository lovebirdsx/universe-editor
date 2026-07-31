/*---------------------------------------------------------------------------------------------
 *  Quick open across restarts (@p1).
 *
 *  验证（bug 回归守护）：
 *   1. 重启前关闭的非文本编辑器（git graph 等）重启后仍出现在 Ctrl+P 列表，
 *      并以精确类型恢复 —— 依赖 ClosedEditorsService 的 workspace 持久化，
 *      修复前重启后点击会落进 resolver 兜底成空白 FileEditorInput。
 *   2. 历史版本泄漏进 recent files 的虚拟资源条目（universe:/acp/session/<guid>）
 *      启动时被清洗，不再以 guid 标签出现在列表中。
 *
 *  实现：照 smoke.editorRestore 的套路直接预写 userData 下的
 *  workspaces/<hash>.json + state.json，独立启动一个 app 实例。
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, APP_ROOT, closeApp } from '../fixtures/electronApp.js'
import { WorkbenchPO, evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const SESSION_GUID = 'e2e-stale-guid-3f2a9c'

function fsPathToUriComponents(fsPath: string) {
  const forwardSlash = fsPath.replace(/\\/g, '/')
  const path = forwardSlash.startsWith('/') ? forwardSlash : '/' + forwardSlash
  return { scheme: 'file', authority: '', path, query: '', fragment: '' }
}

/** Stable workspace id — must mirror main/storage.ts:workspaceIdFromUri. */
function workspaceIdFromFolder(folderFsPath: string): string {
  const path = folderFsPath.replace(/\\/g, '/')
  const uriString = 'file://' + (path.startsWith('/') ? path : '/' + path)
  return createHash('sha1').update(uriString).digest('hex').slice(0, 16)
}

/** Seed the workspace bucket: a persisted closed git-graph editor plus a stale
 *  virtual-resource recent-files entry left behind by older builds. */
function seedWorkspaceFile(userDataDir: string, folder: string): void {
  const hash = workspaceIdFromFolder(folder)
  const wsDir = join(userDataDir, 'workspaces')
  mkdirSync(wsDir, { recursive: true })
  const payload = {
    'workbench.closedEditors': [
      {
        resource: { scheme: 'universe', authority: '', path: '/gitGraph', query: '', fragment: '' },
        typeId: 'gitGraph',
        groupId: 0,
        serializedData: null,
        label: 'Git Graph',
      },
    ],
    'workbench.recentFiles': [
      {
        uri: {
          scheme: 'universe',
          authority: '',
          path: `/acp/session/${SESSION_GUID}`,
          query: '',
          fragment: '',
        },
        name: SESSION_GUID,
        lastOpened: Date.now(),
      },
    ],
  }
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

test.describe('@p1 quick open across restarts', () => {
  test('a closed non-text editor restores with its exact type; stale virtual recent entries are scrubbed', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-quickopen-restart-'))
    try {
      const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-'))
      writeFileSync(join(workspaceFolder, 'anchor.txt'), 'anchor')

      seedGlobalSession(userDataDir, workspaceFolder)
      seedWorkspaceFile(userDataDir, workspaceFolder)

      const { app, page } = await launchWithState(userDataDir)
      try {
        const workbench = new WorkbenchPO(page)
        await page.evaluate(() => {
          void window.__E2E__!.runCommand('workbench.action.quickOpen')
        })
        await workbench.quickInput.waitForVisible()

        // The closed git-graph tab from the "previous session" is listed under
        // its real label and restores as a gitGraph editor, not a text tab.
        const gitGraphOption = workbench.quickInput.dialog.getByRole('option', {
          name: /Git Graph/,
        })
        await expect(gitGraphOption).toBeVisible()

        // The stale universe:/acp/session/<guid> recent entry must be gone —
        // before the fix it showed up labelled by the raw guid and opened as
        // an empty text editor.
        await expect(
          workbench.quickInput.dialog.getByRole('option', { name: new RegExp(SESSION_GUID) }),
        ).toHaveCount(0)

        await gitGraphOption.first().click()
        await workbench.quickInput.waitForHidden()
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
            timeout: 5000,
          })
          .toBe('gitGraph')
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
        /* noop — temp dir cleanup is best-effort */
      }
    }
  })
})
