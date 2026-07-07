/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Explorer auto-detects files created out-of-band (e.g. a shell
 *  `echo hello > test.txt`). The file watcher should surface the new file in the
 *  tree without any user action. Repro for "Explorer can't detect externally
 *  created files".
 *
 *  The two-window case guards the real regression: the file watcher is per-window,
 *  so opening a second window on a different folder must not tear down the first
 *  window's watch — both windows keep detecting their own external files.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/electronApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'
import type { Page } from '@playwright/test'

async function waitForProbe(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
  await evaluateWhenRestored(page)
}

test.describe('@p1 explorer external file detection', () => {
  test('a file created externally appears in the tree automatically @regression', async ({
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-extwatch-'))
    await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'seed')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    // Tree has rendered the workspace; the seed file is visible.
    await expect(
      workbench.page.locator('[role="treeitem"]', { hasText: 'existing.txt' }),
    ).toBeVisible({ timeout: 5000 })

    // Out-of-band creation, mimicking `echo hello > test.txt` from a shell — no
    // editor command involved.
    await fs.writeFile(path.join(tmpDir, 'created-externally.txt'), 'hello')

    // The watcher must surface it without any user interaction.
    await expect(
      workbench.page.locator('[role="treeitem"]', { hasText: 'created-externally.txt' }),
    ).toBeVisible({ timeout: 8000 })

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('both windows keep detecting their own external files @regression', async ({
    electronApp,
    workbench,
  }) => {
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-extwatch-a-'))
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-extwatch-b-'))
    await fs.writeFile(path.join(dirA, 'seed-a.txt'), 'seed')
    await fs.writeFile(path.join(dirB, 'seed-b.txt'), 'seed')

    // Window A opens folder A.
    await workbench.waitForRestored()
    await workbench.openWorkspace(dirA)
    await expect(
      workbench.page.locator('[role="treeitem"]', { hasText: 'seed-a.txt' }),
    ).toBeVisible({ timeout: 5000 })

    // Window B opens folder B in a new window — this used to steal A's watch.
    const newWindow = electronApp.waitForEvent('window')
    await workbench.openFolderInNewWindow(dirB)
    const pageB = await newWindow
    await waitForProbe(pageB)
    await expect(pageB.locator('[role="treeitem"]', { hasText: 'seed-b.txt' })).toBeVisible({
      timeout: 8000,
    })

    // External creation in both folders.
    await fs.writeFile(path.join(dirA, 'created-in-a.txt'), 'hello')
    await fs.writeFile(path.join(dirB, 'created-in-b.txt'), 'hello')

    // Each window must surface its own new file without any user interaction.
    await expect(
      workbench.page.locator('[role="treeitem"]', { hasText: 'created-in-a.txt' }),
    ).toBeVisible({ timeout: 8000 })
    await expect(pageB.locator('[role="treeitem"]', { hasText: 'created-in-b.txt' })).toBeVisible({
      timeout: 8000,
    })

    await fs.rm(dirA, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    await fs.rm(dirB, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
