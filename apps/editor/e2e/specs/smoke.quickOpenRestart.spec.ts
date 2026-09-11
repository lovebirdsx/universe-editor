/*---------------------------------------------------------------------------------------------
 *  Quick open across restarts (@p1).
 *
 *  验证（bug 回归守护）：
 *   1. 重启前关闭的非文本编辑器（git graph 等）重启后仍出现在 Ctrl+P 列表，
 *      并以精确类型恢复 —— 依赖 ClosedEditorsService 的 workspace 持久化，
 *      修复前重启后点击会落进 resolver 兜底成空白 FileEditorInput。
 *   2. 历史版本泄漏进 recent files 的虚拟资源条目（universe:/acp/session/<guid>）
 *      启动时被清洗，不再以 guid 标签出现在列表中。
 *   3. Ctrl+Tab 的最近使用顺序按工作区持久化，重启后重放上次会话的真实顺序，
 *      而不是退化成「active tab 打头 + tab 顺序」。
 *
 *  实现：照 smoke.editorRestore 的套路直接预写 userData 下的
 *  workspaces/<hash>.json + state.json，独立启动一个 app 实例。
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  ENABLED_EXTENSIONS_ENV,
  INITIAL_SETTINGS,
  INITIAL_STATE,
  launchElectron,
  mkTempDir,
} from '@universe-editor/e2e-harness'
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
    ...(JSON.parse(INITIAL_STATE) as Record<string, unknown>),
    'workbench.windowsState': [
      { workspace: { folder: folderComponents, name }, uiState: null, devToolsOpen: false },
    ],
    'workbench.recentWorkspaces': [{ folder: folderComponents, name, lastOpened: Date.now() }],
  }
  writeFileSync(join(userDataDir, 'state.json'), JSON.stringify(payload, null, 2))
}

async function launchWithState(userDataDir: string) {
  writeFileSync(join(userDataDir, 'settings.json'), INITIAL_SETTINGS, 'utf8')
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
  const app = await launchElectron({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: {
      ...inheritedEnv,
      UNIVERSE_E2E: '1',
      NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      [ENABLED_EXTENSIONS_ENV]: '',
    },
  })
  // A failing readiness step must not leak the half-dead app (the test body's
  // own closeApp runs only after this helper returns).
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )
    await evaluateWhenRestored(page)
    return { app, page }
  } catch (err) {
    await closeApp(app)
    throw err
  }
}

/** The renderer debounces the recency write (200ms) and main persists the value
 *  before the storage `set()` promise resolves, so waiting for the bucket on
 *  disk guarantees the second boot below has something to replay. Views the
 *  session focused are persisted next to the editors, hence the filter. */
async function waitForPersistedRecency(
  userDataDir: string,
  folder: string,
  order: readonly string[],
): Promise<void> {
  const bucket = join(userDataDir, 'workspaces', `${workspaceIdFromFolder(folder)}.json`)
  await expect
    .poll(
      () => {
        try {
          const raw = JSON.parse(readFileSync(bucket, 'utf8')) as Record<string, unknown>
          const entries = raw['workbench.recentTargets']
          if (!Array.isArray(entries)) return '<none>'
          return entries
            .map((entry: { id?: string }) => entry.id?.split('/').pop() ?? '?')
            .filter((name: string) => order.includes(name))
            .join(',')
        } catch {
          return '<none>'
        }
      },
      { timeout: 15_000 },
    )
    .toBe(order.join(','))
}

test.describe('@p1 quick open across restarts', () => {
  test('a closed non-text editor restores with its exact type; stale virtual recent entries are scrubbed', async () => {
    // Self-launched cold boot: leave room for the graceful-close + force-kill
    // teardown under full-suite parallel load (see smoke.viewSizes).
    test.setTimeout(120_000)
    const userDataDir = mkTempDir('universe-editor-quickopen-restart-')
    try {
      const workspaceFolder = mkTempDir('universe-editor-ws-')
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

  // Bug regression: the recency list lived only in memory, so a restart rebuilt
  // it from the restore order (active tab first, then tab order) and threw the
  // user's actual order away — Ctrl+Tab looked "reset".
  test('the Ctrl+Tab recency order survives a restart @regression', async () => {
    test.setTimeout(120_000)
    const userDataDir = mkTempDir('universe-editor-quickopen-mru-')
    const workspaceFolder = mkTempDir('universe-editor-ws-')
    try {
      for (const name of ['alpha.ts', 'bravo.ts', 'charlie.ts']) {
        writeFileSync(join(workspaceFolder, name), `// ${name}\n`)
      }
      seedGlobalSession(userDataDir, workspaceFolder)

      // Session one: open in an order that differs from the tab order, so tabs
      // end up [bravo, charlie, alpha] (alpha active) while the true recency
      // order is [alpha, charlie, bravo].
      const first = await launchWithState(userDataDir)
      try {
        const workbench = new WorkbenchPO(first.page)
        for (const name of ['bravo.ts', 'charlie.ts', 'alpha.ts']) {
          await first.page.evaluate(
            (p) => window.__E2E__!.openFileUri(p, { pinned: true }),
            join(workspaceFolder, name).replace(/\\/g, '/'),
          )
        }
        await expect.poll(() => workbench.getActiveEditorUri()).toContain('alpha.ts')
        await waitForPersistedRecency(userDataDir, workspaceFolder, [
          'alpha.ts',
          'charlie.ts',
          'bravo.ts',
        ])
      } finally {
        await closeApp(first.app)
      }

      // Session two: the tabs restore in tab order, so the old, memory-only list
      // would open on [alpha, bravo, charlie]. The recency list must instead
      // read [alpha, charlie, bravo].
      const second = await launchWithState(userDataDir)
      try {
        const workbench = new WorkbenchPO(second.page)
        await second.page.keyboard.down('Control')
        await second.page.evaluate(() => {
          void window.__E2E__!.runCommand('workbench.action.quickOpenRecentEditor')
        })
        await workbench.quickInput.waitForVisible()
        await second.page.keyboard.up('Control')

        const labels = await workbench.quickInput.dialog.getByRole('option').allTextContents()
        const idxOf = (name: string) => labels.findIndex((l) => l.includes(name))
        expect(idxOf('charlie.ts')).toBeGreaterThanOrEqual(0)
        expect(idxOf('charlie.ts')).toBeLessThan(idxOf('bravo.ts'))

        await second.page.keyboard.press('Escape')
        await workbench.quickInput.waitForHidden()
      } finally {
        await closeApp(second.app)
      }
    } finally {
      for (const dir of [workspaceFolder, userDataDir]) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        } catch {
          /* noop — temp dir cleanup is best-effort */
        }
      }
    }
  })
})
