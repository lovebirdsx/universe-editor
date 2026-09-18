/*---------------------------------------------------------------------------------------------
 *  Sub-project agent session scope (@p1).
 *
 *  巨型单仓下会话可以扎在工作区**子目录**上。这条 spec 守护三件事，任一回退都会
 *  让「子目录会话」退化成外来工作区体验：
 *
 *    1. `New Agent Session Here` 把子目录真的透传成了 agent 的 cwd（echo agent
 *       的 `report-cwd` 回报 `session/new` 收到的值，一次回复即证明全链路）；
 *    2. 该会话行在最严格的 `workspace` 作用域下依然可见（列表过滤按「当前工作区
 *       及其子树」而非严格路径相等）；
 *    3. 该行 `data-foreign="false"` —— 不是外来工作区，点击走 live 恢复而不是
 *       只读预览。
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const SESSIONS_VIEW = 'workbench.view.sessions.main'
const SUB_SEGMENTS = ['packages', 'client', 'app'] as const

/** UriComponents for a local path — exactly one leading slash, forward slashes. */
function localUriComponents(fsPath: string): { scheme: 'file'; path: string } {
  const normalized = fsPath.replace(/\\/g, '/')
  return { scheme: 'file', path: normalized.startsWith('/') ? normalized : `/${normalized}` }
}

test.describe('@p1 agents — sub-project session scope', () => {
  test('New Agent Session Here roots the agent in the subdirectory and stays non-foreign', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const wsDir = realpathSync.native(mkTempDir('universe-editor-e2e-subproject-'))
    const subDir = join(wsDir, ...SUB_SEGMENTS)
    mkdirSync(subDir, { recursive: true })
    await workbench.openWorkspace(wsDir)

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // The strictest scope: `workspace` used to keep exact-cwd rows only, which
    // filtered sub-directory sessions out of the list entirely.
    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('acp.sessions.historyScope', 'workspace'),
    )
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.agent.openView'))
    await expect(page.locator(`[data-view-pane="${SESSIONS_VIEW}"]`)).toBeVisible({ timeout: 5000 })

    // Fire-and-forget: createSession spawns + initializes in the background.
    await page.evaluate((folder) => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSessionInFolder', {
        parent: folder,
      })
    }, localUriComponents(subDir))

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 15000 })
      .toBe(1)

    // 1. cwd plumbing: the agent process was started against the subdirectory.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('report-cwd'))
    await expect
      .poll(
        async () => {
          const messages = await page.evaluate(() => window.__E2E__!.getAcpMessages())
          return messages.find((m) => m.role === 'agent')?.text ?? ''
        },
        { timeout: 15000 },
      )
      .not.toBe('')
    const reportedCwd = await page.evaluate(() => {
      const messages = window.__E2E__!.getAcpMessages()
      return messages.find((m) => m.role === 'agent')?.text ?? ''
    })
    // `path.relative` is separator- and (on win32) case-aware, so it absorbs the
    // separator / drive-letter round-tripping that `URI.file().fsPath` performs.
    // An empty result would mean the agent landed on the workspace root instead.
    expect(relative(wsDir, reportedCwd)).toBe(join(...SUB_SEGMENTS))

    // 2 + 3. The row survives `workspace` scope and is not treated as foreign.
    const durableRow = page.locator('li[data-testid^="session-row-echo-"]')
    await expect(durableRow).toHaveCount(1, { timeout: 15000 })
    await expect(durableRow).toHaveAttribute('data-foreign', 'false')

    // The chat carries the working-directory badge so the scope is visible.
    await expect(page.locator('[data-testid="acp-session-cwd"]')).toBeVisible({ timeout: 5000 })
  })

  test('@-mention lists only files under the session subdirectory', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const wsDir = realpathSync.native(mkTempDir('universe-editor-e2e-mention-scope-'))
    const subDir = join(wsDir, ...SUB_SEGMENTS)
    mkdirSync(join(subDir, 'src'), { recursive: true })
    writeFileSync(join(wsDir, 'root-only.ts'), 'export const rootOnly = 1\n')
    writeFileSync(join(subDir, 'src', 'inside.ts'), 'export const inside = 1\n')
    await workbench.openWorkspace(wsDir)

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    await page.evaluate((folder) => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSessionInFolder', {
        parent: folder,
      })
    }, localUriComponents(subDir))

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 15000 })
      .toBe(1)

    await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), {
        timeout: 5000,
      })
      .toBe(true)
    await page.keyboard.type('@')

    // The listing is walked asynchronously (ripgrep in the main process), so the
    // row count is the assertion — it settles at exactly the one file the
    // session's own directory holds, not the workspace's two.
    const popover = page.getByTestId('acp-mention-popover')
    await expect(popover).toBeVisible({ timeout: 10000 })
    const rows = popover.getByRole('option')
    await expect(rows).toHaveCount(1, { timeout: 15000 })
    await expect(rows.first()).toContainText('src/inside.ts')
    await expect(popover).not.toContainText('root-only.ts')
  })
})
