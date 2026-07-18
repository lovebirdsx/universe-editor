/*---------------------------------------------------------------------------------------------
 *  Inline dirty-diff peek (quick diff widget) smoke test (@p1).
 *
 *  Clicking a dirty-diff gutter bar opens an inline peek (HEAD ↔ current) over the
 *  change. This guards the three VSCode-parity behaviours added on top of the
 *  basic peek:
 *    1. Esc closes the peek (gated by the `dirtyDiffPeekVisible` context key).
 *    2. The peek opens at a capped height (≤ the 80% max) and is resizable.
 *    3. Opening a change that's outside the viewport scrolls it into view.
 *
 *  Setup: a real git repo with a committed long file, opened in the editor, then
 *  the buffer is edited far down so a single large change region exists off the
 *  initial (top-of-file) viewport. HEAD content comes from the git extension.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

const LINE_COUNT = 160
// A large contiguous change block, placed well below the fold so the change is
// off-screen at the top and its desired height exceeds the initial 1/3 cap.
const CHANGE_START = 60
const CHANGE_END = 130

function makeBaseline(): string {
  return Array.from({ length: LINE_COUNT }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
}

function makeModified(): string {
  return Array.from({ length: LINE_COUNT }, (_, i) => {
    const n = i + 1
    if (n >= CHANGE_START && n <= CHANGE_END) return `const line${n} = ${n} /* CHANGED */`
    return `const line${n} = ${n}`
  }).join('\n')
}

test.describe('@p1 dirty diff peek', () => {
  test('opens capped + resizable, scrolls into view, and closes on Escape', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ddp-'))
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

    // `git rev-parse --show-toplevel` (used by the git extension to key its repo)
    // always returns the LONG canonical path. On CI Windows `os.tmpdir()` is an 8.3
    // short path (`C:\Users\RUNNER~1\...`), so the raw mkdtemp path wouldn't match
    // the toplevel — `getHeadContent`'s `relative(root, file)` would break and dirty
    // -diff regions would never compute. realpath.native normalizes to the long form.
    const repoDir = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ddp-repo-')),
    )
    git(repoDir, 'init')
    git(repoDir, 'config', 'user.email', 'e2e@example.com')
    git(repoDir, 'config', 'user.name', 'E2E')
    const filePath = join(repoDir, 'sample.ts')
    writeFileSync(filePath, makeBaseline(), 'utf8')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'init')

    const app = await launchCoreGitApp({ userDataDir })

    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await evaluateWhenRestored(page)

      // Open the git workspace and wait for the git extension's source control.
      await page.evaluate((p) => window.__E2E__!.openWorkspace(p), repoDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'git extension should register a source control',
        })
        .toBeGreaterThan(0)

      // Open the committed file, then dirty the buffer far down so a single large
      // change region sits below the top-of-file viewport. setActiveEditorText
      // resets the cursor to line 1 (editor scrolled to the top).
      await page.evaluate((p) => window.__E2E__!.openFileUri(p, { pinned: true }), filePath)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()?.length ?? 0), {
          timeout: 30_000,
        })
        .toBeGreaterThan(0)
      await page.evaluate((text) => window.__E2E__!.setActiveEditorText(text), makeModified())

      // The dirty-diff regions are computed against HEAD asynchronously; opening
      // the peek at the change line only succeeds once they exist.
      await expect
        .poll(
          () =>
            page.evaluate((line) => window.__E2E__!.openDirtyDiffPeekAtLine(line), CHANGE_START),
          { timeout: 30_000, message: 'dirty-diff peek should open at the change' },
        )
        .toBe(true)

      // (3) The change was off-screen (editor at top); opening it scrolls it into
      // view — the host editor's first visible line moves down past line 1.
      // (2) The panel opens capped: a positive height not exceeding the 80% max.
      const opened = await page.evaluate(() => window.__E2E__!.getDirtyDiffPeekState())
      expect(opened?.open).toBe(true)
      expect(opened!.panelHeightPx).toBeGreaterThan(0)
      expect(opened!.panelHeightPx).toBeLessThanOrEqual(opened!.maxHeightPx)
      expect(opened!.editorFirstVisibleLine).toBeGreaterThan(1)
      expect(await page.evaluate(() => window.__E2E__!.isDirtyDiffPeekVisible())).toBe(true)

      // (2) Dragging the bottom edge grows the panel, clamped at the max height.
      const grown = await page.evaluate(() => window.__E2E__!.resizeDirtyDiffPeekByPx(5000))
      expect(grown).toBeGreaterThan(opened!.panelHeightPx)
      expect(grown).toBeLessThanOrEqual(opened!.maxHeightPx)

      // (1) Escape closes the peek and clears the context key.
      await page.keyboard.press('Escape')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.isDirtyDiffPeekVisible()), {
          timeout: 10_000,
          message: 'Escape should close the dirty-diff peek',
        })
        .toBe(false)
      expect(await page.evaluate(() => window.__E2E__!.getDirtyDiffPeekState())).toBeUndefined()
    } finally {
      await closeApp(app)
    }
  })
})
