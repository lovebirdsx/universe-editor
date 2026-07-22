/*---------------------------------------------------------------------------------------------
 *  Maximized-window secondary sidebar restore smoke test (@p1).
 *
 *  守护的 bug：窗口最大化 + 有打开的 editor 时，重启（或最大化/还原）后 secondary
 *  sidebar 的宽度被重置。两层根因：
 *
 *  1. 容器尺寸变化的增量分配：外层横向 Allotment 用 proportionalLayout=false，
 *     layout(新宽度) 从「最后一个 pane」（= secondary sidebar）开始分配增量。
 *     Fix: editor pane 设 LayoutPriority.High —— 与 VSCode 一致（侧栏保持宽度、
 *     编辑器伸缩），垂直分割的 editor pane 同理（防 panel 高度被撑大）。
 *
 *  2. 启动竞态 + 瞬态持久化：带最大化状态重启时（state.json isMaximized=true），
 *     main 在 ready-to-show 才 maximize()，renderer 的初始布局与 reconcile
 *     （异步恢复 visible/sizes）竞速。Allotment 在 SplitView 构造时捕获 onChange
 *     闭包，初始化分支读到过期的 secondarySidebarVisible=false，把二级侧栏当隐藏
 *     来算目标；随后可见性翻转把 pane 挤到 minSize(170)，这一瞬态帧又被 onChange
 *     无条件持久化 —— 污染完成且无人纠正。
 *     Fix: 初始化 resize 的目标全部在微任务里经 ref 现读；sidebar/secondary 的
 *     持久化移到 onDragEnd（只有用户拖拽 sash 才写回，VSCode 语义），容器缩放 /
 *     启动沉降 / 程序性纠正的瞬态帧永远不会再进持久化。
 *
 *  真实机器上 OS 最大化会先在小尺寸布局、再撑大容器。bug 的触发条件是「容器宽度
 *  变化」本身，而 CI runner 的虚拟显示器既小（win ≈1024 / xvfb ≈1280）又可能没有
 *  窗口管理器（xvfb 下 maximize() 是 no-op、isMaximized() 恒 false）——所以增长 /
 *  收缩两条时间线用 setBounds 显式改窗口尺寸（任何环境确定生效），等待条件只用
 *  相对阈值；启动竞态时间线仍 seed isMaximized=true 走 main 的真实 maximize 路径，
 *  但不断言 OS 最大化状态。
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { URI } from '@universe-editor/platform'
import { MAIN_ENTRY, APP_ROOT, closeApp } from '../fixtures/electronApp.js'

const SAVED_SECONDARY_PX = 320

function workspaceIdFromUri(uriString: string): string {
  return createHash('sha1').update(uriString).digest('hex').slice(0, 16)
}

/** UriComponents for URI.file(). */
function fsPathToUriComponents(fsPath: string) {
  const forwardSlash = fsPath.replace(/\\/g, '/')
  const path = forwardSlash.startsWith('/') ? forwardSlash : '/' + forwardSlash
  return { scheme: 'file', authority: '', path, query: '', fragment: '' }
}

function buildEditorGroupsState(filePath: string) {
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
              editors: [{ typeId: 'file', data: { resource: fsPathToUriComponents(filePath) } }],
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

/**
 * Seed a userData dir with: one restorable window (900×700, optionally
 * maximized), a workspace whose layout has the secondary sidebar visible at a
 * distinctive width, and an open editor (a precondition for the bug's timing).
 */
function seedUserData(userDataDir: string, opts: { isMaximized: boolean }) {
  const workspaceDir = join(userDataDir, 'fixture-workspace')
  mkdirSync(workspaceDir, { recursive: true })
  const testFile = join(workspaceDir, 'hello.json')
  writeFileSync(testFile, '{ "restored": true }')

  const workspaceUri = URI.file(workspaceDir)
  const workspaceId = workspaceIdFromUri(workspaceUri.toString())

  const sessionState = {
    'workbench.windowsState': [
      {
        workspace: { folder: workspaceUri.toJSON(), name: basename(workspaceDir) },
        uiState: {
          x: 100,
          y: 100,
          width: 900,
          height: 700,
          isMaximized: opts.isMaximized,
          isFullscreen: false,
          displayId: 0,
        },
        devToolsOpen: false,
      },
    ],
  }
  writeFileSync(join(userDataDir, 'state.json'), JSON.stringify(sessionState, null, 2))

  const workspaceState = {
    'workbench.layout': {
      visible: {
        activityBar: true,
        sideBar: true,
        secondarySideBar: true,
        editorArea: true,
        panel: false,
        statusBar: true,
      },
      sizes: { sidebar: 240, secondarySidebar: SAVED_SECONDARY_PX, panel: 200 },
    },
    'workbench.workspaceState': { groups: buildEditorGroupsState(testFile) },
  }
  mkdirSync(join(userDataDir, 'workspaces'), { recursive: true })
  writeFileSync(
    join(userDataDir, 'workspaces', `${workspaceId}.json`),
    JSON.stringify(workspaceState, null, 2),
  )
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
  await page.evaluate(() => window.__E2E__!.whenReady())
  return { app, page }
}

function getSecondaryDomWidth(page: Awaited<ReturnType<typeof launchWithState>>['page']) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="part-secondarysidebar"]')
    return el ? Math.round(el.getBoundingClientRect().width) : null
  })
}

async function expectSecondaryDomNearSaved(
  page: Awaited<ReturnType<typeof launchWithState>>['page'],
) {
  await expect
    .poll(() => getSecondaryDomWidth(page), {
      timeout: 5000,
      message: 'secondary sidebar DOM width should settle near the saved width',
    })
    .toBeGreaterThan(SAVED_SECONDARY_PX - 20)
  const domWidth = await getSecondaryDomWidth(page)
  expect(domWidth!).toBeLessThan(SAVED_SECONDARY_PX + 20)
}

/**
 * Grow the window via setBounds instead of BrowserWindow.maximize(): CI
 * runners have tiny virtual displays (win ≈1024px, xvfb ≈1280px) and xvfb has
 * no window manager at all, so maximize() may be a no-op there. The bug is
 * triggered by the container width changing, not by the OS-maximize gesture,
 * and setBounds deterministically changes the width in every environment.
 * Growth is capped to the work area to stay honest on small displays; the
 * wait uses a relative threshold, never an absolute width.
 */
async function growWindow(
  app: Awaited<ReturnType<typeof launchWithState>>['app'],
  page: Awaited<ReturnType<typeof launchWithState>>['page'],
) {
  const before = await page.evaluate(() => window.innerWidth)
  await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    const work = screen.getPrimaryDisplay().workAreaSize
    const bounds = win.getBounds()
    const width = Math.min(Math.max(work.width, bounds.width + 120), 1600)
    win.setBounds({ x: 0, y: 0, width, height: bounds.height })
  })
  await page.waitForFunction((w) => window.innerWidth > w, before + 60, { timeout: 10_000 })
}

async function shrinkWindow(
  app: Awaited<ReturnType<typeof launchWithState>>['app'],
  page: Awaited<ReturnType<typeof launchWithState>>['page'],
  targetWidth: number,
) {
  await app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    const bounds = win.getBounds()
    win.setBounds({ x: bounds.x, y: bounds.y, width: w, height: bounds.height })
  }, targetWidth)
  await page.waitForFunction((w) => window.innerWidth <= w, targetWidth, { timeout: 10_000 })
}

test.describe('@p1 maximized secondary sidebar restore', () => {
  test('secondary sidebar width survives maximizing a window with an open editor @regression', async () => {
    test.slow()
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-maxsec-'))
    try {
      seedUserData(userDataDir, { isMaximized: false })

      // The bug needs the initial Allotment layout to happen at the small
      // width and settle FIRST; only then does maximizing grow the container
      // and dump the extra width onto the last pane (secondary sidebar).
      const { app, page } = await launchWithState(userDataDir)
      try {
        // Editor must have restored (a precondition for the bug's timing).
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
            timeout: 15_000,
          })
          .toContain('hello.json')

        // Wait for the initial (small-width) layout to settle at the saved width.
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.__E2E__!.getLayoutSizes())).secondarySidebar,
            { timeout: 15_000 },
          )
          .toBe(SAVED_SECONDARY_PX)

        // Grow the container AFTER the initial layout settled — the
        // real-world maximize trigger, made deterministic via setBounds.
        await growWindow(app, page)

        // Service level: the persisted secondary width must NOT be inflated. Before
        // the fix the maximize growth is dumped onto the secondary pane (→ 1000).
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.__E2E__!.getLayoutSizes())).secondarySidebar,
            { timeout: 5000, message: 'secondary sidebar width should survive maximizing' },
          )
          .toBe(SAVED_SECONDARY_PX)

        // DOM level: the secondary sidebar pane must render near the saved width.
        await expectSecondaryDomNearSaved(page)
      } finally {
        await closeApp(app)
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test('secondary sidebar width survives restarting while maximized @regression', async () => {
    test.slow()
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-maxsec-restart-'))
    try {
      // The real user flow: quit while maximized, relaunch. Main maximizes the
      // window at ready-to-show, racing the renderer's initial layout AND the
      // async layout reconcile — before the fix, a stale Allotment closure let
      // a transient frame squeeze the pane to its min width (170) and persist it.
      seedUserData(userDataDir, { isMaximized: true })
      const { app, page } = await launchWithState(userDataDir)
      try {
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
            timeout: 15_000,
          })
          .toContain('hello.json')
        // No isMaximized() assertion: xvfb has no window manager, so the
        // ready-to-show maximize() may be a no-op there (the state is never
        // acknowledged). The guarded property is the persisted width below —
        // on platforms with a WM this run still exercises the full
        // maximized-restart race.

        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.__E2E__!.getLayoutSizes())).secondarySidebar,
            {
              timeout: 15_000,
              message: 'persisted secondary width must survive a maximized restart',
            },
          )
          .toBe(SAVED_SECONDARY_PX)
        await expectSecondaryDomNearSaved(page)
      } finally {
        await closeApp(app)
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test('secondary sidebar width survives maximize then restore @regression', async () => {
    test.slow()
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-maxsec-unmax-'))
    try {
      seedUserData(userDataDir, { isMaximized: false })
      const { app, page } = await launchWithState(userDataDir)
      try {
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
            timeout: 15_000,
          })
          .toContain('hello.json')
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.__E2E__!.getLayoutSizes())).secondarySidebar,
            { timeout: 15_000 },
          )
          .toBe(SAVED_SECONDARY_PX)

        await growWindow(app, page)

        // Shrink back — the delta must come out of the editor pane, and the
        // transient shrink frames must not be persisted.
        await shrinkWindow(app, page, 900)

        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.__E2E__!.getLayoutSizes())).secondarySidebar,
            { timeout: 5000, message: 'secondary width should survive maximize → restore' },
          )
          .toBe(SAVED_SECONDARY_PX)
        await expectSecondaryDomNearSaved(page)
      } finally {
        await closeApp(app)
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
