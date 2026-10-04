import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { test, expect } from '../fixtures/electronApp.js'
import type { Page } from '@playwright/test'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

test.use({
  workspaceSeeder: {
    seed(dir: string) {
      mkdirSync(path.join(dir, 'packages', 'platform'), { recursive: true })
      writeFileSync(path.join(dir, 'README.md'), '# workspace\n')
      writeFileSync(path.join(dir, 'packages', 'README.md'), '# packages\n')
      writeFileSync(path.join(dir, 'packages', 'platform', 'index.ts'), 'export {}\n')
      // 真实生效的 files.watcherExclude：只排除监听，不影响文件树显示。
      mkdirSync(path.join(dir, '.vscode'), { recursive: true })
      writeFileSync(
        path.join(dir, '.vscode', 'settings.json'),
        JSON.stringify({ 'files.watcherExclude': { '**/packages/**': true } }),
      )
    },
  },
})

/** 等监听请求确认并展开 packages，使其成为「已加载」目录。 */
async function openAndExpandPackages(workbench: WorkbenchPO, page: Page): Promise<void> {
  await workbench.waitForRestored()
  // 等启动监听请求确认，避免外部写入发生在初始化前。
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.isWorkspaceWatchArmed()), { timeout: 10_000 })
    .toBe(true)
  await expect
    .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
    .toBe(true)

  const packagesRow = page.locator('[role="treeitem"]', { hasText: /^packages$/ })
  await expect(packagesRow).toBeVisible({ timeout: 5000 })
  await packagesRow.click()
  // platform 出现 = packages 已加载；刷新要重读的正是这类已加载目录。
  await expect(page.locator('[role="treeitem"]', { hasText: /^platform$/ })).toBeVisible({
    timeout: 5000,
  })
}

test.describe('explorer refresh nested dirs', () => {
  test('toolbar refresh surfaces a nested folder the excluded watcher missed @regression', async ({
    workbench,
    page,
    launchWorkspace,
  }) => {
    await openAndExpandPackages(workbench, page)

    // 外部新建嵌套目录：packages 被 watcherExclude 剪枝，监听不会上报它。
    await fs.mkdir(launchWorkspace!.file('packages/primitives'))
    const primitivesRow = page.locator('[role="treeitem"]', { hasText: /^primitives$/ })
    await expect(primitivesRow).toHaveCount(0)

    // 工具栏「刷新资源管理器」：递归重读已加载的 packages → 新目录出现。
    await page.locator('button[data-tooltip="Refresh Explorer"]').click()
    await expect(primitivesRow).toBeVisible({ timeout: 5000 })
  })

  test('refresh command surfaces a nested folder the excluded watcher missed @regression', async ({
    workbench,
    page,
    launchWorkspace,
  }) => {
    await openAndExpandPackages(workbench, page)

    await fs.mkdir(launchWorkspace!.file('packages/primitives'))
    const primitivesRow = page.locator('[role="treeitem"]', { hasText: /^primitives$/ })
    await expect(primitivesRow).toHaveCount(0)

    // 命令入口与工具栏走同一条刷新路径。
    await workbench.runCommand('workbench.files.action.refresh')
    await expect(primitivesRow).toBeVisible({ timeout: 5000 })
  })
})
