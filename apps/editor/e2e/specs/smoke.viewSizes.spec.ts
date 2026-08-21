/*---------------------------------------------------------------------------------------------
 *  View pane size persistence smoke test (@p0).
 *
 *  验证 VSCode 范式的 view 尺寸机制：
 *   A. 折叠一个 view 再展开，两个 view 都恢复原来的尺寸（不被等分重置），
 *      且折叠期间持久化的展开尺寸不被 28px header 覆盖。
 *   B. 拖动 sash 调整尺寸后重载窗口，尺寸按 workspace 作用域持久化恢复。
 *
 *  默认 explorer 容器自带两个 view（explorer.tree + timeline.main），直接用它。
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENABLED_EXTENSIONS_ENV,
  INITIAL_SETTINGS,
  INITIAL_STATE,
  launchElectron,
} from '@universe-editor/e2e-harness'
import { MAIN_ENTRY, APP_ROOT, closeApp } from '../fixtures/electronApp.js'
import { expectNoLeaks, evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const TREE_VIEW = 'workbench.view.explorer.tree'
const TIMELINE_VIEW = 'workbench.view.timeline.main'
const EXPLORER_CONTAINER = 'workbench.view.explorer'
const HEADER_H = 28

function seedUserSettings(userDataDir: string): void {
  writeFileSync(join(userDataDir, 'settings.json'), INITIAL_SETTINGS, 'utf8')
}

function fsPathToUriComponents(fsPath: string) {
  const forwardSlash = fsPath.replace(/\\/g, '/')
  const path = forwardSlash.startsWith('/') ? forwardSlash : '/' + forwardSlash
  return { scheme: 'file', authority: '', path, query: '', fragment: '' }
}

/** Seed state.json so the app restores a single window into `folder`. */
function seedGlobalState(userDataDir: string, folder: string): void {
  const folderComponents = fsPathToUriComponents(folder)
  const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify(
      {
        ...(JSON.parse(INITIAL_STATE) as Record<string, unknown>),
        'workbench.windowsState': [
          { workspace: { folder: folderComponents, name }, uiState: null, devToolsOpen: false },
        ],
      },
      null,
      2,
    ),
  )
}

async function waitForRestored(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
  await evaluateWhenRestored(page)
}

async function launchWithState(userDataDir: string) {
  seedUserSettings(userDataDir)
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
  const app = await launchElectron({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: {
      ...inheritedEnv,
      UNIVERSE_E2E: '1',
      NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      // Core-only baseline (same as the fixtures): view-pane sizing needs no
      // extensions, and skipping the LSP hosts avoids the orphaned child
      // processes that wedge app.close() past its graceful window.
      [ENABLED_EXTENSIONS_ENV]: '',
    },
  })
  // A failing readiness step must not leak the half-dead app (the test body's
  // own closeApp runs only after this helper returns).
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitForRestored(page)
    return { app, page }
  } catch (err) {
    await closeApp(app)
    throw err
  }
}

async function paneHeight(page: import('@playwright/test').Page, viewId: string): Promise<number> {
  const box = await page.locator(`[data-view-pane="${viewId}"]`).boundingBox()
  return box?.height ?? 0
}

async function waitForPanes(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator(`[data-view-pane="${TREE_VIEW}"]`)).toBeVisible()
  await expect(page.locator(`[data-view-pane="${TIMELINE_VIEW}"]`)).toBeVisible()
  // Wait until the mounted Allotment reports real geometry.
  await expect
    .poll(async () => paneHeight(page, TREE_VIEW), { timeout: 5000 })
    .toBeGreaterThan(HEADER_H)
}

test.describe('@p0 view pane sizes', () => {
  test('collapse + expand restores both panes to their previous sizes', async () => {
    // Self-launched cold boot; under full-suite parallel load the teardown's
    // graceful-close + force-kill recovery alone can eat ~20s — the default
    // 30s ceiling is too tight (the assertions themselves finish in seconds).
    test.setTimeout(120_000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-viewsize-'))
    const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-viewsize-'))
    try {
      seedGlobalState(userDataDir, workspaceFolder)
      const { app, page } = await launchWithState(userDataDir)
      try {
        await waitForPanes(page)
        const h1 = await paneHeight(page, TREE_VIEW)
        const h2 = await paneHeight(page, TIMELINE_VIEW)

        // Collapse the top pane: it shrinks to its header, the other absorbs.
        await page.evaluate((id) => window.__E2E__!.setViewCollapsed(id, true), TREE_VIEW)
        await expect
          .poll(async () => paneHeight(page, TREE_VIEW), { timeout: 5000 })
          .toBeLessThanOrEqual(HEADER_H + 1)
        await expect
          .poll(async () => paneHeight(page, TIMELINE_VIEW), { timeout: 5000 })
          .toBeGreaterThan(h2 + h1 - HEADER_H - 3)

        // While collapsed, the persisted expanded size must not be clobbered
        // by the 28px header height.
        const storedWhileCollapsed = await page.evaluate(
          (id) => window.__E2E__!.getViewSize(id),
          TREE_VIEW,
        )
        expect(storedWhileCollapsed).toBeGreaterThan(HEADER_H)

        // Expand again: both panes return to their previous sizes.
        await page.evaluate((id) => window.__E2E__!.setViewCollapsed(id, false), TREE_VIEW)
        await expect
          .poll(async () => Math.abs((await paneHeight(page, TREE_VIEW)) - h1), { timeout: 5000 })
          .toBeLessThanOrEqual(3)
        await expect
          .poll(async () => Math.abs((await paneHeight(page, TIMELINE_VIEW)) - h2), {
            timeout: 5000,
          })
          .toBeLessThanOrEqual(3)
        await expectNoLeaks(page)
      } finally {
        await closeApp(app)
      }
    } finally {
      for (const dir of [workspaceFolder, userDataDir]) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        } catch {
          /* best-effort */
        }
      }
    }
  })

  test('sash-dragged sizes survive a window reload', async () => {
    test.setTimeout(120_000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-viewsize2-'))
    const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-viewsize2-'))
    try {
      seedGlobalState(userDataDir, workspaceFolder)
      const { app, page } = await launchWithState(userDataDir)
      try {
        await waitForPanes(page)

        // Drag the sash between the two panes down by 60px.
        const sash = page.locator(`[data-container-drop="${EXPLORER_CONTAINER}"] .sash`).first()
        const box = await sash.boundingBox()
        expect(box).not.toBeNull()
        const cx = box!.x + box!.width / 2
        const cy = box!.y + box!.height / 2
        await page.mouse.move(cx, cy)
        await page.mouse.down()
        await page.mouse.move(cx, cy + 60, { steps: 5 })
        await page.mouse.up()

        const h1 = await paneHeight(page, TREE_VIEW)
        const h2 = await paneHeight(page, TIMELINE_VIEW)
        const stored1 = await page.evaluate((id) => window.__E2E__!.getViewSize(id), TREE_VIEW)
        expect(stored1).toBeGreaterThan(HEADER_H)

        await page.evaluate(() => window.__E2E__!.flushViewCustomizationsSave())

        // Reload the window; the dragged sizes must be restored.
        const loaded = page.waitForEvent('load')
        void page
          .evaluate(() => void window.__E2E__!.runCommand('workbench.action.reloadWindow'))
          .catch(() => {})
        await loaded
        await waitForRestored(page)
        await waitForPanes(page)

        await expect
          .poll(async () => Math.abs((await paneHeight(page, TREE_VIEW)) - h1), { timeout: 5000 })
          .toBeLessThanOrEqual(5)
        await expect
          .poll(async () => Math.abs((await paneHeight(page, TIMELINE_VIEW)) - h2), {
            timeout: 5000,
          })
          .toBeLessThanOrEqual(5)
        await expectNoLeaks(page)
      } finally {
        await closeApp(app)
      }
    } finally {
      for (const dir of [workspaceFolder, userDataDir]) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        } catch {
          /* best-effort */
        }
      }
    }
  })
})
