/*---------------------------------------------------------------------------------------------
 *  Explorer → Agent Chat: right-clicking a file or folder offers "Send to Agent
 *  Chat", which must land in the prompt as the same @-mention pill drag-and-drop
 *  produces (relative label, no `file:///` leaking into the text).
 *
 *  Covers both shapes: a file becomes one file ref; a folder becomes a single
 *  folder ref (Explorer semantics — unlike SCM, where a folder expands to its
 *  subtree).
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@p1 send Explorer resources to Agent Chat', () => {
  // Cold launch: an ACP session spawns an agent process in main with
  // cwd = workspace, so the shared fixture would leak that state into the next
  // test. workspaceSeeder pins the folder at launch (no post-boot openWorkspace,
  // hence no double extension-host restart) and its cleanup runs after
  // closeApp, when the watcher/agent handles are gone.
  test.use({
    workspaceSeeder: {
      seed(dir) {
        mkdirSync(join(dir, 'src'), { recursive: true })
        writeFileSync(join(dir, 'alpha.txt'), 'a')
        writeFileSync(join(dir, 'src', 'beta.ts'), 'b')
      },
    },
  })

  test('file and folder both insert a relative @-mention pill', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.openView'))
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.newSession'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    const prompt = page.getByTestId('acp-prompt-drop-host')
    // The drop host renders before its embedded Monaco is ready; insertRef
    // no-ops until the editor mounts (same gate as the drag spec).
    await expect(prompt.locator('.monaco-editor').first()).toBeVisible({ timeout: 10000 })

    const alpha = page.locator('[role="treeitem"]', { hasText: 'alpha.txt' })
    await expect(alpha).toBeVisible({ timeout: 10000 })
    await alpha.click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toHaveCount(1)
    await menu.getByRole('menuitem', { name: 'Send to Agent Chat' }).click()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()))
      .toContain('@alpha.txt')
    expect(await page.evaluate(() => window.__E2E__!.getAcpPromptText())).not.toContain('file:///')

    const folder = page.locator('[role="treeitem"]', { hasText: /^src$/ }).first()
    await expect(folder).toBeVisible({ timeout: 10000 })
    await folder.click({ button: 'right' })
    await expect(menu).toHaveCount(1)
    await menu.getByRole('menuitem', { name: 'Send to Agent Chat' }).click()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()))
      .toContain('@src ')
    expect(await page.evaluate(() => window.__E2E__!.getAcpPromptText())).not.toContain('file:///')
  })
})
