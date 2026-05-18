/*---------------------------------------------------------------------------------------------
 *  Editor state restore smoke test (@p1).
 *
 *  验证打开的文件编辑器在重启后从 state.json 正确恢复：
 *  通过预写入 state.json（userData 目录）直接测试 restore 路径，绕开 persist 步骤。
 *
 *  根本原因（修复前）：
 *    EditorRegistry.registerEditorProvider({ typeId: 'file', ... }) 位于
 *    EditorArea.tsx 模块级代码，而 EditorArea.tsx 随 Workbench 动态 chunk
 *    一起加载（await import('./workbench/Workbench.js')），该加载发生在
 *    lifecycle.setPhase(LifecyclePhase.Ready) 之后。
 *    与此同时，WorkspaceRestoreContribution._restore() 的 storage.get() IPC
 *    调用比 Workbench chunk 解析更快完成，导致 _restore() 在 'file' provider
 *    尚未注册时就运行，所有 FileEditorInput 被静默跳过。
 *
 *  修复后：
 *    BuiltInEditorProvidersContribution（BlockStartup 阶段）同步注册所有
 *    内置编辑器 provider，确保在 WorkspaceRestoreContribution（BlockRestore
 *    阶段）构造之前 EditorRegistry 中已有 'file' provider。
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, APP_ROOT } from '../fixtures/electronApp.js'

/** Convert a filesystem path to the UriComponents format used by URI.file(). */
function fsPathToUriComponents(fsPath: string) {
  const forwardSlash = fsPath.replace(/\\/g, '/')
  // On Windows "D:/foo" must become "/D:/foo" (URI path always starts with /).
  const path = forwardSlash.startsWith('/') ? forwardSlash : '/' + forwardSlash
  return { scheme: 'file', authority: '', path, query: '', fragment: '' }
}

/** Build the workbench.workspaceState JSON that mirrors EditorGroupsService.toJSON(). */
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

async function launchWithState(userDataDir: string) {
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: { ...process.env, UNIVERSE_E2E: '1', NODE_ENV: process.env['NODE_ENV'] ?? 'production' },
  })
  const page = await app.firstWindow()
  // firstWindow() can return before the renderer's first navigation commits;
  // wait for the real document before probing window globals, otherwise
  // page.evaluate may race with a context swap and throw "Execution context
  // was destroyed, most likely because of a navigation."
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
  // Retry once if the renderer happens to navigate (e.g. devtools reload)
  // between probe detection and evaluate — that's the only realistic cause
  // here, and a single retry after re-waiting for the probe is sufficient.
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
  test('file editor is restored from state.json after restart', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-editor-restore-'))

    try {
      // Create the file that will be referenced by the persisted editor state.
      const testFile = join(userDataDir, 'hello.json')
      writeFileSync(testFile, '{ "restored": true }')

      // Pre-seed state.json — simulates a prior session where hello.json was open.
      const seededState = {
        'workbench.workspaceState': {
          groups: buildWorkspaceState(testFile),
        },
      }
      writeFileSync(join(userDataDir, 'state.json'), JSON.stringify(seededState, null, 2))

      const { app, page } = await launchWithState(userDataDir)
      try {
        // _restore() is fire-and-forget (void); the storage IPC call may resolve
        // after setPhase(Restored), so poll until the active editor URI appears.
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
            timeout: 5000,
          })
          .toContain('hello.json')
      } finally {
        await app.close()
      }
    } finally {
      // Windows: Electron's LevelDB / Local Storage files can linger briefly
      // after app.close(); a stray EBUSY here doesn't invalidate the assertion
      // and the OS will reclaim the temp dir, so don't fail the test on cleanup.
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* noop — temp dir cleanup is best-effort */
      }
    }
  })
})
