/*---------------------------------------------------------------------------------------------
 *  @p1 — list rows honour Ctrl/Meta+Enter (side group) and Alt+Enter (auxiliary
 *  window), covering the Explorer and the git diff entry points (SCM + Commit
 *  Changes). The quick-pick variant lives in smoke.quickPickOpenTargets.
 *
 *  Files are copied into the side group (the original tab stays); sessions and
 *  previews move instead. These specs assert the copy for plain files and that
 *  the targeted open lands in a *new* group/window rather than the active one.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { URI } from '@universe-editor/platform'
import { mkTempDir, seedBaselineUserData } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/electronApp.js'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

// The workbench restores focus to the active editor for ~1.5s after a workspace
// settles; waiting it out keeps the first row click from stealing tree focus.
const RESTORE_WINDOW_MS = 1700

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

function mainWindowUris(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const probe = window.__E2E__!
    const main = probe.getWorkbenchWindows().find((w) => w.isMain)
    if (!main) return []
    return main.groupIds.flatMap((id) => probe.getEditorGroupEditorUris(String(id)))
  })
}

async function focusRow(page: Page, row: Locator): Promise<void> {
  await row.click()
  const tree = page.locator('[role="tree"]').filter({ has: row }).first()
  await page.waitForTimeout(RESTORE_WINDOW_MS)
  await tree.focus()
  await expect(tree).toHaveAttribute('data-focused', 'true')
}

test.describe('@p1 explorer open targets', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'alpha.ts'), 'export const alpha = 1\n')
        writeFileSync(join(dir, 'beta.ts'), 'export const beta = 2\n')
      },
    },
  })

  test('Ctrl+Enter opens the selected file to the side and keeps the original tab', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (!launchWorkspace) throw new Error('workspaceSeeder 未生效')
    await workbench.waitForRestored()
    await workbench.showExplorer()

    const alpha = page.locator('[role="treeitem"]', { hasText: 'alpha.ts' })
    await expect(alpha).toBeVisible({ timeout: 10_000 })
    await focusRow(page, alpha)

    const beforeGroupId = await workbench.getActiveGroupId()
    await page.keyboard.press('Control+Enter')

    await expect.poll(() => workbench.getEditorGroupCount(), { timeout: 10_000 }).toBe(2)
    const sideGroupId = await workbench.getActiveGroupId()
    expect(sideGroupId).not.toBe(beforeGroupId)

    const uri = URI.file(launchWorkspace.file('alpha.ts')).toString()
    expect(
      await page.evaluate(
        ({ id, file }) => window.__E2E__!.getEditorGroupEditorUris(id).includes(file),
        { id: String(sideGroupId), file: uri },
      ),
    ).toBe(true)

    // Files are copied: the source group keeps its tab and the side group has a
    // second instance of the same URI.
    expect((await mainWindowUris(page)).filter((u) => u === uri)).toHaveLength(2)
  })

  test('Alt+Enter opens the selected file in an auxiliary window', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    if (!launchWorkspace) throw new Error('workspaceSeeder 未生效')
    await workbench.waitForRestored()
    await workbench.showExplorer()

    const beta = page.locator('[role="treeitem"]', { hasText: 'beta.ts' })
    await expect(beta).toBeVisible({ timeout: 10_000 })
    await focusRow(page, beta)

    await page.keyboard.press('Alt+Enter')

    const uri = URI.file(launchWorkspace.file('beta.ts')).toString()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAuxiliaryWindows().length), {
        timeout: 20_000,
      })
      .toBe(1)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window
            .__E2E__!.getAuxiliaryWindows()[0]!
            .groups.flatMap((g) => g.editorUris)
            .join('|'),
        ),
      )
      .toContain(uri)
    expect(await mainWindowUris(page)).toContain(uri)
  })
})

function makeRepo(): { repoDir: string; secondHash: string } {
  // realpath.native: the raw mkdtemp path on CI Windows is an 8.3 short path.
  const repoDir = realpathSync.native(mkTempDir('universe-editor-e2e-targets-repo-'))
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'e2e@example.com')
  git(repoDir, 'config', 'user.name', 'E2E')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n')
  writeFileSync(join(repoDir, 'b.ts'), 'const b = 1\n')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'first')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2\n')
  writeFileSync(join(repoDir, 'b.ts'), 'const b = 2\n')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'second')
  const secondHash = git(repoDir, 'rev-parse', 'HEAD')
  // Leave a working-tree change so the SCM view has an unstaged file row.
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 3\n')
  return { repoDir, secondHash }
}

async function launchGitRepo(): Promise<{
  app: ElectronApplication
  page: Page
  repoDir: string
  secondHash: string
}> {
  const userDataDir = mkTempDir('universe-editor-e2e-targets-')
  seedBaselineUserData(userDataDir)
  const { repoDir, secondHash } = makeRepo()
  const app = await launchCoreGitApp({ userDataDir, extraArgs: [repoDir] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
  await evaluateWhenRestored(page)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
      timeout: 60_000,
      message: 'git extension should register a source control',
    })
    .toBeGreaterThan(0)
  return { app, page, repoDir, secondHash }
}

test.describe('@p1 scm open targets', () => {
  test('Ctrl+Enter on an SCM file opens its diff to the side', async () => {
    test.setTimeout(120_000)
    const { app, page } = await launchGitRepo()
    try {
      await page.evaluate(() => window.__E2E__!.runCommand('workbench.view.scm'))
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveViewContainerId(0)), {
          timeout: 30_000,
        })
        .toBe('workbench.view.scm')

      const row = page.locator('[role="treeitem"]', { hasText: 'a.ts' }).first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      await focusRow(page, row)

      const beforeGroupId = await page.evaluate(() => window.__E2E__!.getActiveGroupId())
      await page.keyboard.press('Control+Enter')

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getEditorGroupCount()), {
          timeout: 20_000,
        })
        .toBe(2)
      const activeGroupId = await page.evaluate(() => window.__E2E__!.getActiveGroupId())
      expect(activeGroupId).not.toBe(beforeGroupId)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 20_000,
        })
        .toBe('diff')
      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              window.__E2E__!.getEditorGroupEditorUris(id).some((uri) => uri.includes('a.ts')),
            String(activeGroupId),
          ),
        )
        .toBe(true)
    } finally {
      await closeApp(app)
    }
  })

  test('Ctrl+Enter on a Commit Changes file opens its diff to the side', async () => {
    test.setTimeout(120_000)
    const { app, page, repoDir, secondHash } = await launchGitRepo()
    try {
      await page.evaluate(
        ({ uri, hash }) => window.__E2E__!.runCommand('git.viewCommit', uri, hash),
        {
          uri: URI.file(join(repoDir, 'a.ts')).toString(),
          hash: secondHash,
        },
      )
      const view = page.locator('[data-testid="commitChanges-view"]')
      await expect(view).toBeVisible({ timeout: 30_000 })
      const fileRow = view.locator('[data-row-key="file:a.ts"]')
      await expect(fileRow).toBeVisible({ timeout: 30_000 })

      const tree = view.locator('[role="tree"]').first()
      await fileRow.click()
      await page.waitForTimeout(RESTORE_WINDOW_MS)
      await tree.focus()
      await expect(tree).toHaveAttribute('data-focused', 'true')

      const beforeGroupId = await page.evaluate(() => window.__E2E__!.getActiveGroupId())
      await page.keyboard.press('Control+Enter')

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getEditorGroupCount()), {
          timeout: 20_000,
        })
        .toBe(2)
      const activeGroupId = await page.evaluate(() => window.__E2E__!.getActiveGroupId())
      expect(activeGroupId).not.toBe(beforeGroupId)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 20_000,
        })
        .toBe('diff')
      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              window.__E2E__!.getEditorGroupEditorUris(id).some((uri) => uri.includes('a.ts')),
            String(activeGroupId),
          ),
        )
        .toBe(true)
    } finally {
      await closeApp(app)
    }
  })
})
