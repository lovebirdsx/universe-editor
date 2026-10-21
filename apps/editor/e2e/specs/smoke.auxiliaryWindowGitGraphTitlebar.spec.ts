/*---------------------------------------------------------------------------------------------
 *  Auxiliary window title bar height regression (@regression).
 *
 *  Moving a Git Graph editor into an auxiliary window used to collapse the title
 *  bar to ~15px. The window root is a column flex container and the title bar
 *  header only declared `height: 30px` — as a flex item it defaulted to
 *  `flex: 0 1 auto`, so the editor pane's content-sized flex basis (a 500-commit
 *  graph canvas is ~12000px tall) produced negative free space and shrank the
 *  header to min-content. The main window is immune: its title bar sits inside a
 *  wrapper fixed at `flex: 0 0 30px`.
 *
 *  Compares against the main title bar instead of hardcoding 30px: any mismatch
 *  between the two windows is the regression.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { test, expect } from '../fixtures/coreGitApp.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

/** A linear history of `count` commits built with one `git fast-import` spawn. */
function seedLinearHistory(dir: string, count: number): void {
  git(dir, 'init')
  git(dir, 'config', 'user.email', 'e2e@example.com')
  git(dir, 'config', 'user.name', 'E2E')
  const branch = git(dir, 'symbolic-ref', '--short', 'HEAD')
  const lines = ['blob', 'mark :1', 'data 2', 'a']
  for (let i = 1; i <= count; i++) {
    const message = `c${i}`
    lines.push(
      `commit refs/heads/${branch}`,
      `mark :${i + 1}`,
      `committer E2E <e2e@example.com> ${1700000000 + i} +0000`,
      `data ${message.length}`,
      message,
      ...(i > 1 ? [`from :${i}`] : []),
      'M 100644 :1 a.ts',
      '',
    )
  }
  lines.push('done', '')
  execFileSync('git', ['fast-import', '--done'], {
    cwd: dir,
    input: lines.join('\n'),
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  git(dir, 'reset', '--hard')
}

test.describe('auxiliary window git graph title bar', () => {
  test.use({
    workspaceSeeder: {
      seed(dir: string) {
        seedLinearHistory(dir, 520)
      },
    },
  })

  test('keeps its height above a tall git graph @regression', async ({
    electronApp,
    workbench,
    page,
  }) => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)
    await workbench.waitForRestored()

    await expect
      .poll(() => workbench.getScmSourceControlCount(), {
        timeout: 60_000,
        message: 'git extension should register a source control',
      })
      .toBeGreaterThan(0)

    // First page is 500 commits: the graph canvas is ~12000px tall.
    await workbench.runCommand('git-graph.view')
    const mainGraph = page.locator('[data-testid="gitGraph-editor"]')
    await expect(mainGraph).toBeVisible()
    await expect(mainGraph.locator('[data-testid="gitGraph-commitCount"]')).toContainText(
      '500 commits+',
      { timeout: 30_000 },
    )

    // Register the listener first: the native window can appear before the
    // command's IPC round-trip resolves.
    const windowPromise = electronApp.waitForEvent('window')
    await workbench.runCommand('workbench.action.moveEditorToNewWindow')
    const child = await windowPromise
    await child.waitForLoadState('domcontentloaded')
    await expect(child.locator('[data-testid="part-editorArea"]')).toBeVisible()

    const auxGraph = child.locator('[data-testid="gitGraph-editor"]')
    await expect(auxGraph).toBeVisible()
    await expect(auxGraph.locator('[data-testid="gitGraph-commitCount"]')).toContainText(
      '500 commits+',
      { timeout: 30_000 },
    )

    // Precondition: the graph really is taller than the auxiliary window, so
    // the layout is actually under the negative-free-space condition.
    const content = await child.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('[data-testid="gitGraph-scrollBody"]')
      if (!scroll) throw new Error('gitGraph-scrollBody missing')
      return {
        viewport: window.innerHeight,
        clientHeight: scroll.clientHeight,
        scrollHeight: scroll.scrollHeight,
      }
    })
    expect(content.scrollHeight).toBeGreaterThan(content.viewport)
    expect(content.scrollHeight).toBeGreaterThan(content.clientHeight)

    const mainBar = page.locator('[data-testid="titlebar"]')
    const auxBar = child.locator('[data-testid="auxiliary-titlebar"]')
    const barHeight = (locator: typeof mainBar): Promise<number> =>
      locator.evaluate((el) => el.getBoundingClientRect().height)

    await expect
      .poll(() => barHeight(mainBar), { message: 'main title bar should be laid out' })
      .toBeGreaterThan(20)

    await expect
      .poll(async () => Math.abs((await barHeight(auxBar)) - (await barHeight(mainBar))), {
        timeout: 10_000,
        message:
          'auxiliary title bar must match the main title bar (it collapsed to ~15px before the fix)',
      })
      .toBeLessThanOrEqual(1)

    const token = (await page.evaluate(() => window.__E2E__!.getAuxiliaryWindows()))[0]!.token
    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAuxiliaryWindows().length))
      .toBe(0)
  })
})
