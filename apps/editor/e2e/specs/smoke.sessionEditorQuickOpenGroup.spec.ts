/*---------------------------------------------------------------------------------------------
 *  Quick open of a previously-closed file must land in the focused group (@regression).
 *
 *  用户实测必现 bug：左右两个 editor group 各放一个 ACP session editor，这个文本
 *  文件早前曾在左组打开并关闭过（closed-editors 栈持久化，可跨重启存活）。鼠标点击
 *  右边会话的 prompt 输入框聚焦后按 Ctrl+P 打开该文件，文件却出现在左边的 group。
 *
 *  根因（本 spec 守护）：FileQuickAccessProvider._restoreClosed 把刚关闭的编辑器按
 *  条目里记录的 groupId 原组恢复并 activateGroup——那条目可能来自任意早的会话，
 *  与用户当前焦点无关。quick open 的语义是"开到我正在工作的组"（activeGroup），
 *  还原历史组是 Ctrl+Shift+T（Reopen Closed Editor）专属的行为。
 *
 *  断言分两步：
 *    1. 点击右组 prompt 后 IEditorGroupsService.activeGroup 必须是右组
 *       （走只读探针 getActiveGroupId，等同 DOM data-group-id）。
 *    2. Ctrl+P 打开的文件必须落在右组，且 activeGroup 留在右组。
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import type { Page } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

async function activeElementGroup(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.activeElement
        ?.closest<HTMLElement>('[data-group-id]')
        ?.getAttribute('data-group-id') ?? null,
  )
}

async function groupIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-group-id]')).map(
      (el) => el.dataset['groupId']!,
    ),
  )
}

async function activeGroupId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__E2E__!.getActiveGroupId())
}

async function newEchoSession(page: Page, count: number): Promise<void> {
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 15000 })
    .toBe(count)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
    .toBe('acp.session')
}

test.describe('@regression quick open targets the focused group even for a previously-closed file', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(resolve(dir, 'quickopen-target.txt'), 'quick open target\n')
      },
    },
  })

  test('Ctrl+P reopens a once-closed file into the group whose session prompt was clicked @regression', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    await workbench.waitForRestored()
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    if (!launchWorkspace) throw new Error('workspace seeder did not run')

    // 病根前置条件:目标文件曾在（唯一的、后来的左）组里打开并关闭 → closed 栈
    // 记下 groupId。之后任何 Ctrl+P 打开该文件都会走 _restoreClosed。
    await page.evaluate(
      (file) => window.__E2E__!.openFileUri(file),
      launchWorkspace.file('quickopen-target.txt'),
    )
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()))
      .toContain('quickopen-target.txt')
    await workbench.runCommand('workbench.action.closeActiveEditor')

    // 用户顺序:先左组 session A,再 splitEditorRight,再右组 session B。
    await newEchoSession(page, 1)
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    await newEchoSession(page, 2)

    const [leftId, rightId] = await groupIds(page)
    expect(leftId).toBeDefined()
    expect(rightId).toBeDefined()
    expect(leftId).not.toBe(rightId)

    // 先点左组 prompt(用户在左组工作过),activeGroup 应归左。
    await page
      .locator(`[data-group-id="${leftId}"] [data-testid="acp-prompt-drop-host"] .monaco-editor`)
      .first()
      .click()
    await expect.poll(() => activeElementGroup(page)).toBe(leftId)
    await expect.poll(() => activeGroupId(page)).toBe(leftId)

    // 再点右组 prompt —— 用户手势。activeGroup 必须翻到右组(断言一)。
    await page
      .locator(`[data-group-id="${rightId}"] [data-testid="acp-prompt-drop-host"] .monaco-editor`)
      .first()
      .click()
    await expect.poll(() => activeElementGroup(page)).toBe(rightId)
    await expect.poll(() => activeGroupId(page)).toBe(rightId)

    // Ctrl+P 打开该文件:必须落在右组,且 activeGroup 留在右组(断言二)。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()
    await workbench.quickInput.input.fill('quickopen-target')
    const option = workbench.quickInput.dialog.getByRole('option', { name: /quickopen-target/ })
    await expect(option).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()))
      .toContain('quickopen-target.txt')
    await expect.poll(() => activeGroupId(page)).toBe(rightId)
    await expect.poll(() => activeElementGroup(page)).toBe(rightId)
  })
})
