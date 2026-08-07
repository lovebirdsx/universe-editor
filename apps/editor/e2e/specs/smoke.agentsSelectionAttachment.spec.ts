/*---------------------------------------------------------------------------------------------
 *  Selection attachment message smoke (@p0).
 *
 *  Select editor text, run Ctrl+K Ctrl+L's command, send, then assert the user
 *  message still carries the read-only file:line attachment after submission.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@p0 agents selection attachment', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(resolve(dir, 'selection.ts'), 'const first = 1\nconst selected = 2\n')
      },
    },
  })

  test('Ctrl+K Ctrl+L selection remains attached after send', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    await workbench.waitForRestored()
    await page.evaluate(([id, path, env]) => window.__E2E__!.installAcpEchoAgent(id, path, env), [
      'echo',
      ECHO_AGENT_PATH,
      { ECHO_AGENT_LOAD_SESSION: '1' },
    ] as const)

    if (!launchWorkspace) throw new Error('workspace seeder did not run')
    await page.evaluate(
      (file) => window.__E2E__!.openFileUri(file),
      launchWorkspace.file('selection.ts'),
    )
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
      .toContain('selection.ts')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorSelection(2, 1, 2, 19)))
      .toBe(true)
    await page.evaluate(() => window.__E2E__!.addActiveSelectionToAcpPrompt())
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })
    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('acp.prompt.confirmShortFirstMessageLength', 0),
    )
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')))
      .toBe(true)
    await page.keyboard.type('Explain this selection')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
      .toContainEqual({
        role: 'user',
        text: 'Explain this selection',
        selectionLabels: ['selection.ts:2'],
      })
    await expect(page.getByTestId('acp-selection-context-chip')).toHaveText('selection.ts:2')

    // 等 echo 回复落地再 reload：上面的 user 消息是本地乐观上屏，不等 attach 完成；
    // 而 echo agent 的 session/load 只接受跑过 prompt 的 session。agent 回复出现
    // 才同时证明 durable session id 已就位且 prompt 已在 agent 端落账。
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.__E2E__!.getAcpMessages())).some(
            (m) => m.role === 'agent',
          ),
        { timeout: 15000 },
      )
      .toBe(true)

    const beforeReload = await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())
    const afterReload = await page.evaluate(() => window.__E2E__!.reloadActiveAcpSession())
    expect(afterReload).not.toBe(beforeReload)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 10000 })
      .toContainEqual({
        role: 'user',
        text: 'Explain this selection',
        selectionLabels: ['selection.ts:2'],
      })
    await expect(page.getByTestId('acp-selection-context-chip')).toHaveText('selection.ts:2')
  })
})
