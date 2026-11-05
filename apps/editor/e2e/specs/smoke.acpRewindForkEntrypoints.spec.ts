/*---------------------------------------------------------------------------------------------
 *  ACP rewind / fork command entry points (@p1).
 *
 *  回退/分叉原本只有鼠标悬停按钮；本次补齐命令面板、快捷键和输入框本地斜杠命令。
 *  单测能覆盖 action 分支与 ContextKeyService 解析，但守不住两件真实产物里的行为：
 *   1. 命令面板打开时焦点已移进 quick input —— 面板行必须挂 root `activeEditorTypeId`
 *      而不是带 `editorAreaFocus` 的条件；
 *   2. `/fork` `/rewind` 只拦截"整条消息恰为命令"的提交，取消选择器后要把命令文本
 *      放回输入框。
 *  这里用 echo agent 的能力位（`ECHO_AGENT_FORK` / `ECHO_AGENT_REWIND`）点亮入口，
 *  只打开选择器后 Escape，不实际执行 fork/rewind RPC。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/sharedApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

async function openPalette(page: Page, workbench: WorkbenchPO): Promise<void> {
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.showCommands')
  })
  await workbench.quickInput.waitForVisible()
  await expect(workbench.quickInput.input).toBeFocused()
}

async function openEchoSession(page: Page, workbench: WorkbenchPO): Promise<void> {
  await workbench.waitForRestored()
  // Short prompts are the norm here; skip the first-message confirmation dialog.
  await page.evaluate(() =>
    window.__E2E__!.updateConfigValue('acp.prompt.confirmShortFirstMessageLength', 0),
  )
  await page.evaluate(
    ([id, p]) =>
      window.__E2E__!.installAcpEchoAgent(id, p, {
        ECHO_AGENT_FORK: '1',
        ECHO_AGENT_REWIND: '1',
      }),
    ['echo', ECHO_AGENT_PATH] as const,
  )
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.openView'))
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.newSession'))
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
    .toBe('acp.session')
  await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })
}

async function focusPrompt(page: Page): Promise<void> {
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'))
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), {
      timeout: 5000,
    })
    .toBe(true)
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  await focusPrompt(page)
  await page.keyboard.type(text)
  await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText())).toBe(text)
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText())).toBe('')
}

test.describe('@p1 acp rewind / fork command entry points', () => {
  test('lists Rewind Agent Session only while a session editor is in front', async ({
    page,
    workbench,
  }) => {
    await openEchoSession(page, workbench)

    // Session editor in front → the palette row survives the palette's focus steal.
    await openPalette(page, workbench)
    await page.keyboard.type('workbench.action.agent.rewindSession')
    await expect(
      workbench.quickInput.dialog.getByRole('option', { name: /Rewind Agent Session/ }),
    ).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    // A file editor in front → the row is gone.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .not.toBe('acp.session')
    await openPalette(page, workbench)
    await page.keyboard.type('workbench.action.agent.rewindSession')
    await expect(workbench.quickInput.dialog).toBeVisible()
    await expect(
      workbench.quickInput.dialog.getByRole('option', { name: /Rewind Agent Session/ }),
    ).toHaveCount(0)
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('the slash popover offers /fork and /rewind and dismissing their picker restores the text', async ({
    page,
    workbench,
  }) => {
    await openEchoSession(page, workbench)
    await sendPrompt(page, 'first prompt')

    await focusPrompt(page)
    await page.keyboard.type('/')
    const popover = page.getByTestId('acp-slash-popover')
    await expect(popover).toBeVisible()
    const options = popover.getByRole('option')
    await expect(options).toHaveCount(2)
    await expect(options.nth(0)).toContainText('/fork')
    await expect(options.nth(1)).toContainText('/rewind')

    // Narrow to /rewind, dismiss the popover (Escape owns it while open), then
    // submit the command itself.
    await page.keyboard.type('rewind')
    await expect(options).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await page.keyboard.press('Enter')

    // No anchor → the message picker opens over the live session.
    await workbench.quickInput.waitForVisible()
    await expect(
      workbench.quickInput.dialog.getByRole('option', { name: /first prompt/ }),
    ).toBeVisible({ timeout: 5000 })

    // Cancelling is not a submission: the typed command comes back to the input.
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()))
      .toMatch(/^\/rewind\s*$/)
  })

  test('Ctrl+Alt+Shift+F / Ctrl+Alt+Shift+Z open the fork and rewind pickers', async ({
    page,
    workbench,
  }) => {
    await openEchoSession(page, workbench)
    await sendPrompt(page, 'first prompt')
    await focusPrompt(page)

    await page.keyboard.press('Control+Alt+Shift+F')
    await workbench.quickInput.waitForVisible()
    await expect(
      workbench.quickInput.dialog.getByRole('option', {
        name: /From the end of the conversation/,
      }),
    ).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    await focusPrompt(page)
    await page.keyboard.press('Control+Alt+Shift+Z')
    await workbench.quickInput.waitForVisible()
    await expect(
      workbench.quickInput.dialog.getByRole('option', { name: /first prompt/ }),
    ).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })
})
