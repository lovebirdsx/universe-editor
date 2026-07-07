/*---------------------------------------------------------------------------------------------
 *  View drag/move + persistence smoke test (@p0).
 *
 *  验证 VSCode 范式的 view↔container 重映射：
 *   1. 通过 IViewDescriptorService 把一个 view 移动到另一个 container，查询立即反映新归属。
 *   2. 重载窗口后（workspace 作用域持久化），view 仍然停留在被移动到的 container。
 *
 *  通过 window.__E2E__ 探针直接驱动服务，绕开 DnD 的鼠标几何，专注验证
 *  数据模型 + 持久化这条主链路。
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, APP_ROOT, closeApp } from '../fixtures/electronApp.js'
import { expectNoLeaks, evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const SEARCH_VIEW = 'workbench.view.search.results'
const EXPLORER_CONTAINER = 'workbench.view.explorer'
const SEARCH_CONTAINER = 'workbench.view.search'

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
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: { ...inheritedEnv, UNIVERSE_E2E: '1', NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production' },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitForRestored(page)
  return { app, page }
}

test.describe('@p0 view move persistence', () => {
  test('a moved view stays in its new container after a window reload', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-viewmove-'))
    const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-viewmove-'))
    try {
      seedGlobalState(userDataDir, workspaceFolder)
      const { app, page } = await launchWithState(userDataDir)
      try {
        // Default home: search view lives in the search container.
        const before = await page.evaluate(
          (id) => window.__E2E__!.getViewContainerByViewId(id),
          SEARCH_VIEW,
        )
        expect(before).toBe(SEARCH_CONTAINER)

        // Move it into the Explorer container and persist.
        await page.evaluate(
          ({ view, container }) => window.__E2E__!.moveViewsToContainer([view], container),
          { view: SEARCH_VIEW, container: EXPLORER_CONTAINER },
        )
        const afterMove = await page.evaluate(
          (id) => window.__E2E__!.getViewContainerByViewId(id),
          SEARCH_VIEW,
        )
        expect(afterMove).toBe(EXPLORER_CONTAINER)

        const explorerViews = await page.evaluate(
          (id) => window.__E2E__!.getViewIdsByContainer(id),
          EXPLORER_CONTAINER,
        )
        expect(explorerViews).toContain(SEARCH_VIEW)

        await page.evaluate(() => window.__E2E__!.flushViewCustomizationsSave())

        // Reload the window; restore should re-home the view in Explorer.
        const loaded = page.waitForEvent('load')
        void page
          .evaluate(() => void window.__E2E__!.runCommand('workbench.action.reloadWindow'))
          .catch(() => {})
        await loaded
        await waitForRestored(page)

        await expect
          .poll(
            () => page.evaluate((id) => window.__E2E__!.getViewContainerByViewId(id), SEARCH_VIEW),
            { timeout: 5000 },
          )
          .toBe(EXPLORER_CONTAINER)
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

  test('moving a view to a location generates a recyclable container', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-viewgen-'))
    const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-viewgen-'))
    try {
      seedGlobalState(userDataDir, workspaceFolder)
      const { app, page } = await launchWithState(userDataDir)
      try {
        // ViewContainerLocation.SecondarySideBar === 1.
        const secondaryBefore = await page.evaluate(() =>
          window.__E2E__!.getViewContainerIdsByLocation(1),
        )

        await page.evaluate((id) => window.__E2E__!.moveViewToLocation(id, 1), SEARCH_VIEW)

        const secondaryAfter = await page.evaluate(() =>
          window.__E2E__!.getViewContainerIdsByLocation(1),
        )
        expect(secondaryAfter.length).toBe(secondaryBefore.length + 1)

        const host = await page.evaluate(
          (id) => window.__E2E__!.getViewContainerByViewId(id),
          SEARCH_VIEW,
        )
        expect(secondaryAfter).toContain(host)

        // Move the view back to its default home → generated container recycles.
        await page.evaluate(
          ({ view, container }) => window.__E2E__!.moveViewsToContainer([view], container),
          { view: SEARCH_VIEW, container: SEARCH_CONTAINER },
        )
        const secondaryEnd = await page.evaluate(() =>
          window.__E2E__!.getViewContainerIdsByLocation(1),
        )
        expect(secondaryEnd.length).toBe(secondaryBefore.length)
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

  test('merging a view container folds all its views into the target and persists', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-viewmerge-'))
    const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-viewmerge-'))
    try {
      seedGlobalState(userDataDir, workspaceFolder)
      const { app, page } = await launchWithState(userDataDir)
      try {
        // Default home: each container owns exactly its own view.
        const explorerBefore = await page.evaluate(
          (id) => window.__E2E__!.getViewIdsByContainer(id),
          EXPLORER_CONTAINER,
        )
        const searchBefore = await page.evaluate(
          (id) => window.__E2E__!.getViewIdsByContainer(id),
          SEARCH_CONTAINER,
        )
        expect(searchBefore).toContain(SEARCH_VIEW)

        // Merge the Search container into the Explorer container (drag-to-centre).
        await page.evaluate(
          ({ source, target }) => window.__E2E__!.mergeViewContainerInto(source, target),
          { source: SEARCH_CONTAINER, target: EXPLORER_CONTAINER },
        )

        // Explorer now holds both containers' views; Search is left empty.
        const explorerAfter = await page.evaluate(
          (id) => window.__E2E__!.getViewIdsByContainer(id),
          EXPLORER_CONTAINER,
        )
        expect(explorerAfter).toEqual([...explorerBefore, ...searchBefore])
        const searchAfter = await page.evaluate(
          (id) => window.__E2E__!.getViewIdsByContainer(id),
          SEARCH_CONTAINER,
        )
        expect(searchAfter).toEqual([])

        await page.evaluate(() => window.__E2E__!.flushViewCustomizationsSave())

        // Reload; the merged layout must survive (workspace-scoped persistence).
        const loaded = page.waitForEvent('load')
        void page
          .evaluate(() => void window.__E2E__!.runCommand('workbench.action.reloadWindow'))
          .catch(() => {})
        await loaded
        await waitForRestored(page)

        await expect
          .poll(
            () =>
              page.evaluate((id) => window.__E2E__!.getViewIdsByContainer(id), EXPLORER_CONTAINER),
            { timeout: 5000 },
          )
          .toEqual([...explorerBefore, ...searchBefore])
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
