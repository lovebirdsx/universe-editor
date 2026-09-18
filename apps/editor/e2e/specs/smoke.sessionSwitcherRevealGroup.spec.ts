/*---------------------------------------------------------------------------------------------
 *  Alt+S onto a session that already has a tab in another group must reveal that
 *  tab instead of opening a duplicate in the active group (@regression).
 *
 *  用户实测必现 bug：左右两个 editor group，session editor 在右组、用户回到左组工作，
 *  按 Alt+S 切到那个已经在右组开着的 session，左组（active）会多出一份同 session 的
 *  重复 tab。根因：会话反向通道的 reveal 直接调 IEditorService.openEditor，而它的去重
 *  只覆盖 active group。修法见 services/acp/session/revealSessionEditorTab.ts（先跨所有
 *  组 find-first，命中就 activateGroup + setActive）。
 *
 *  两个会话的默认标题都是 "Echo Agent HH:MM"（同分钟内必然相同），所以各发一条首条
 *  prompt 让标题可定位——标题在 sendPrompt 内同步写 history，与 switcher 条目同源。
 *  切 session 前先等右组 tab 标题到位，避免 quick pick 读到旧标题而过滤不中。
 *
 *  断言：切换后 activeGroup 归右组，且两组的 tab 列表与切换前逐字相同（旧代码左组为 2）。
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

function activeGroupId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__E2E__!.getActiveGroupId())
}

function groupEditorUris(page: Page, groupId: string): Promise<readonly string[]> {
  return page.evaluate((id) => window.__E2E__!.getEditorGroupEditorUris(id), groupId)
}

function groupHasTabTitled(page: Page, groupId: string, title: string): Promise<boolean> {
  return page.evaluate(
    ([id, t]) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`[data-group-id="${id}"] [role="tab"]`),
      ).some((el) => (el.textContent ?? '').includes(t)),
    [groupId, title] as const,
  )
}

/** 新建一个会落到 active group 的会话，并用首条 prompt 给它一个可定位的标题。 */
async function newEchoSession(page: Page, count: number, prompt: string): Promise<void> {
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 15000 })
    .toBe(count)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
    .toBe('acp.session')
  await page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), prompt)
}

test.describe('@regression Alt+S reveals a session tab that lives in another group', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(resolve(dir, 'switcher-target.txt'), 'switcher target\n')
      },
    },
  })

  test('switching to a session already open in the right group does not duplicate it into the left @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // 两个会话先落在同一组，再把刚建的 B 挪到右侧新组：左组留 A、右组留 B。
    await newEchoSession(page, 1, 'LEFT-SESSION')
    await newEchoSession(page, 2, 'RIGHT-TARGET')
    const targetUri = await page.evaluate(() => window.__E2E__!.getActiveEditorUri())
    await workbench.runCommand('workbench.action.moveEditorToRightGroup')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    const [leftId, rightId] = await groupIds(page)
    if (leftId === undefined || rightId === undefined) {
      throw new Error('expected two editor groups')
    }
    await expect.poll(() => groupEditorUris(page, rightId)).toEqual([targetUri])
    await expect.poll(() => groupEditorUris(page, leftId)).toHaveLength(1)
    const leftBefore = await groupEditorUris(page, leftId)
    const rightBefore = await groupEditorUris(page, rightId)

    // 标题先落到 tab 上（switcher 条目 label 与它同源），再驱动 quick pick。
    await expect.poll(() => groupHasTabTitled(page, rightId, 'RIGHT-TARGET')).toBe(true)

    // 用户手势：点左组 prompt，activeGroup 归左。
    await page
      .locator(`[data-group-id="${leftId}"] [data-testid="acp-prompt-drop-host"] .monaco-editor`)
      .first()
      .click()
    await expect.poll(() => activeElementGroup(page)).toBe(leftId)
    await expect.poll(() => activeGroupId(page)).toBe(leftId)

    // Alt+S 切到那个已经在右组开着的 session。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.switchSession')
    })
    await workbench.quickInput.waitForVisible()
    // 切换器和 Ctrl+Tab 一样以锁定态打开（输入框只读，松开 Alt 直接打开高亮项），
    // 所以要先按 Enter 交还输入权才能填过滤词。
    await expect(workbench.quickInput.input).toHaveAttribute('readonly', '')
    await expect(workbench.quickInput.hint).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(workbench.quickInput.input).not.toHaveAttribute('readonly', '')
    await expect(workbench.quickInput.hint).toBeHidden()
    await workbench.quickInput.input.fill('RIGHT-TARGET')
    const option = workbench.quickInput.dialog.getByRole('option', { name: /RIGHT-TARGET/ })
    await expect(option).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    // 焦点回到持有该 tab 的右组，左组一个 tab 都没多。
    await expect.poll(() => activeGroupId(page)).toBe(rightId)
    await expect.poll(() => groupEditorUris(page, leftId)).toEqual(leftBefore)
    await expect.poll(() => groupEditorUris(page, rightId)).toEqual(rightBefore)
  })
})
