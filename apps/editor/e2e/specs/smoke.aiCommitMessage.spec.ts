/*---------------------------------------------------------------------------------------------
 *  AI commit-message inline button smoke test (@p1).
 *
 *  End-to-end guard for S4 wiring: the `ai` built-in extension contributes
 *  `ai.generateCommitMessage` to the `scm/inputBox` menu point, the renderer
 *  translates that menu key into MenuId.ScmInputBox, and ScmView renders it as an
 *  inline action next to the commit input. We assert the button is present in a
 *  real git workspace — the generation itself needs a live AI model and is
 *  covered by the extension's unit tests, not here.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { APP_ROOT, MAIN_ENTRY } from '../fixtures/electronApp.js'
import { expectNoLeaks } from '../pages/WorkbenchPO.js'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

test.describe('@p1 ai commit message', () => {
  test('contributes an inline generate button next to the commit input', async () => {
    // Boots Electron and activates the git + ai extensions in a real repo. On
    // Windows CI (2 cores, Defender scanning every `git` spawn, Electron-as-node
    // host startup) the cold boot before the SCM poll can eat most of a 30s test
    // budget, tripping the test timeout before the poll fills. Give headroom —
    // mirrors the heavier @p0 generation spec.
    test.setTimeout(120_000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ai-'))
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ 'workbench.language': 'en-US', 'update.mode': 'manual' }, null, 2),
      'utf8',
    )
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({ 'welcome.agentOnboarding.seen': true }, null, 2),
      'utf8',
    )

    // A real git repo with one uncommitted change so the SCM view has a provider.
    const repoDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ai-repo-'))
    git(repoDir, 'init')
    git(repoDir, 'config', 'user.email', 'e2e@example.com')
    git(repoDir, 'config', 'user.name', 'E2E')
    writeFileSync(join(repoDir, 'README.md'), '# hello\n', 'utf8')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'init')
    writeFileSync(join(repoDir, 'README.md'), '# hello world\n', 'utf8')

    const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      cwd: APP_ROOT,
      env: {
        ...inheritedEnv,
        UNIVERSE_E2E: '1',
        NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      },
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await page.evaluate(() => window.__E2E__!.whenRestored())

      // Open the git workspace and wait for the SCM provider to register.
      await page.evaluate((p) => window.__E2E__!.openWorkspace(p), repoDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'git extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)

      // Wait for the ai extension to contribute its command.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('ai.generateCommitMessage')), {
          timeout: 60_000,
          message: 'ai extension should contribute ai.generateCommitMessage',
        })
        .toBe(true)

      // Reveal the SCM view, then assert the inline button renders.
      await page.evaluate(() => window.__E2E__!.runCommand('workbench.view.scm'))
      const button = page.getByRole('button', { name: 'Generate Commit Message' })
      await expect(button).toBeVisible({ timeout: 15_000 })
      await expectNoLeaks(page)
    } finally {
      await app.close()
    }
  })
})
