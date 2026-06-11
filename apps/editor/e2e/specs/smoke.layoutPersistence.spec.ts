/*---------------------------------------------------------------------------------------------
 *  Layout persistence smoke test (@p1).
 *
 *  验证 sidebar 宽度在重启后被正确恢复：
 *  通过预写 state.json（userData 目录）绕开保存步骤，直接测试 restore 路径。
 *
 *  测试边界
 *  - 修复前：layoutService.load() 在 useEffect (React 挂载后) 调用。
 *    whenReady() resolve 时 React 已挂载但 useEffect 未来得及触发；
 *    getLayoutSizes() 立刻返回默认值 240 → 测试失败。
 *  - 修复后：main.tsx 在 createRoot().render() 之前 await layoutService.load()，
 *    React 挂载时 sizes.sidebar 已为 400 → 测试通过。
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { URI } from '@universe-editor/platform'
import { MAIN_ENTRY, APP_ROOT } from '../fixtures/electronApp.js'

const SAVED_SIDEBAR_PX = 400

/** Pre-seeded workspace-scoped layout state (`workspaces/<id>.json`). */
const SEEDED_WORKSPACE_STATE = {
  'workbench.layout': {
    visible: {
      activityBar: true,
      sideBar: true,
      secondarySideBar: false,
      editorArea: true,
      panel: true,
      statusBar: true,
    },
    sizes: { sidebar: SAVED_SIDEBAR_PX, secondarySidebar: 300, panel: 200 },
  },
}

function workspaceIdFromUri(uriString: string): string {
  return createHash('sha1').update(uriString).digest('hex').slice(0, 16)
}

async function launchWithState(userDataDir: string) {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: { ...inheritedEnv, UNIVERSE_E2E: '1', NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production' },
  })
  const page = await app.firstWindow()
  // 等首次导航 commit，避免 evaluate 撞上 "Execution context was destroyed"。
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
  // whenReady() resolves as soon as LifecyclePhase.Ready is reached,
  // which happens BEFORE createRoot().render(). Any measurement taken
  // immediately after this call reflects the state at first React render.
  await page.evaluate(() => window.__E2E__!.whenReady())
  return { app, page }
}

test.describe('@p1 layout persistence', () => {
  test('sidebar width is restored from storage on launch', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-persist-'))

    try {
      // Storage is workspace-scoped: seed the restore session in state.json,
      // then seed workbench.layout in workspaces/<id>.json.
      const workspaceDir = join(userDataDir, 'fixture-workspace')
      mkdirSync(workspaceDir, { recursive: true })

      const workspaceUri = URI.file(workspaceDir)
      const workspaceId = workspaceIdFromUri(workspaceUri.toString())
      const sessionState = {
        'workbench.windowsState': [
          {
            workspace: { folder: workspaceUri.toJSON(), name: basename(workspaceDir) },
            uiState: null,
            devToolsOpen: false,
          },
        ],
      }

      writeFileSync(join(userDataDir, 'state.json'), JSON.stringify(sessionState, null, 2))
      mkdirSync(join(userDataDir, 'workspaces'), { recursive: true })
      writeFileSync(
        join(userDataDir, 'workspaces', `${workspaceId}.json`),
        JSON.stringify(SEEDED_WORKSPACE_STATE, null, 2),
      )

      const { app, page } = await launchWithState(userDataDir)
      try {
        // ── Service level ──────────────────────────────────────────────────────
        // Checked immediately after whenReady(), before any useEffect fires.
        // With the fix, load() ran before React mounted, so sizes are 400.
        // Without the fix, sizes would still be 240 (default) at this point.
        const sizes = await page.evaluate(() => window.__E2E__!.getLayoutSizes())
        expect(sizes.sidebar).toBe(SAVED_SIDEBAR_PX)

        // ── DOM level ──────────────────────────────────────────────────────────
        // Allotment's distributeEmptySpace greedily fills the first pane to its
        // maxSize on initial layout. WorkbenchLayout corrects this via
        // allotmentRef.resize() inside a setTimeout(0) fired from useEffect.
        // We poll until the sidebar settles at the saved width.
        await expect
          .poll(
            async () => {
              const w = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="part-sidebar"]')
                return el ? Math.round(el.getBoundingClientRect().width) : null
              })
              return w
            },
            { timeout: 5000 },
          )
          .toBeGreaterThan(SAVED_SIDEBAR_PX - 20)

        const sidebarWidth = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="part-sidebar"]')
          return el ? Math.round(el.getBoundingClientRect().width) : null
        })
        expect(sidebarWidth).toBeLessThan(SAVED_SIDEBAR_PX + 20)
      } finally {
        await app.close()
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
