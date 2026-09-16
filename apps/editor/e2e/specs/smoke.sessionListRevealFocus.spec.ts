/*---------------------------------------------------------------------------------------------
 *  Activating an already-open session from the session list focuses it (@regression).
 *
 *  用户实测必现 bug：会话列表里点某行 / 按 Enter，如果那个会话已经开着编辑器 tab，
 *  什么都不会发生——既不切到 tab 所在的 editor group，也不把焦点交给 chat 输入框。
 *  根因：activateEntry 的 live 分支只调 setActive，而「activeSession 变化 → 激活 tab」
 *  的 autorun 在 tab 位于**非 active 组**时**刻意早退**（免得开出重复 tab，见
 *  AgentsActiveSessionSyncContribution._isSessionOpenInInactiveGroup）；会话没换时它
 *  更是压根不重跑（observable 同值不通知）。修法见 services/acp/session/revealSessionChat.ts。
 *
 *  两条断言各守一半：「activeGroup 归位」守跨组 reveal，「acpChatFocused」守焦点真的
 *  落进了输入框（EditorGroupView 的焦点 pass + widget 的 focusInput 都会点亮它）。
 *  焦点归属走 document.activeElement 的 [data-group-id] 祖先链（同 smoke.sessionEditorFocus），
 *  不戳 Monaco 内部结构。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'
import type { Locator, Page } from '@playwright/test'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const SESSIONS_VIEW_ID = 'workbench.view.sessions.main'

/** Group whose subtree currently holds DOM focus (null while focus is in the list). */
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

function groupEditorUris(page: Page, groupId: string): Promise<readonly string[]> {
  return page.evaluate((id) => window.__E2E__!.getEditorGroupEditorUris(id), groupId)
}

/** Row under the arrow-key cursor is also the open session? */
const cursorRowIsActive = () => {
  const row = document.querySelector(
    '[role="listbox"][aria-label="Sessions"] li[aria-selected="true"]',
  )
  return row instanceof HTMLElement && row.dataset['active'] === 'true'
}

async function newEchoSession(page: Page, count: number): Promise<void> {
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 20000 })
    .toBe(count)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
    .toBe('acp.session')
}

/**
 * Focus the Sessions view and wait for the focus to actually stick. A freshly
 * opened session's editor claims focus for its prompt input a beat after
 * `newSession` resolves, so one `focusView` can be silently undone — re-issuing
 * it makes the assertion "focus survived the window" instead of "focus happened
 * once". Same helper as smoke.agentsSessionListKeyboard.
 */
async function focusSessionList(page: Page, workbench: WorkbenchPO): Promise<Locator> {
  const list = page.getByRole('listbox', { name: 'Sessions' })
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.agent.openView'))
        await page.waitForTimeout(500)
        return list.getAttribute('data-focused')
      },
      { timeout: 20000 },
    )
    .toBe('true')
  await expect.poll(() => workbench.getContextKey<string>('focusedView')).toBe(SESSIONS_VIEW_ID)
  return list
}

/** Park the list cursor on a row that is NOT the open session, so Enter has an effect. */
async function parkCursorOnInactiveRow(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const onActive = await page.evaluate(cursorRowIsActive)
      if (onActive) await page.keyboard.press('ArrowDown')
      return onActive
    })
    .toBe(false)
}

test.describe('@regression session list — activating an already-open session', () => {
  test('Enter on a row whose tab lives in another group activates that group @regression', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // 两个会话先落在同一组，再把后建的那个（当前 active 的）挪去右侧新组：
    // 左组留 A、右组留 B 且右组为 active 组，activeSession 仍是 B。
    await newEchoSession(page, 1)
    await newEchoSession(page, 2)
    await workbench.runCommand('workbench.action.moveEditorToRightGroup')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    const [leftId, rightId] = await groupIds(page)
    if (leftId === undefined || rightId === undefined) {
      throw new Error('expected two editor groups')
    }
    await expect.poll(() => groupEditorUris(page, rightId)).toHaveLength(1)
    await expect.poll(() => groupEditorUris(page, leftId)).toHaveLength(1)
    const leftBefore = await groupEditorUris(page, leftId)
    const rightBefore = await groupEditorUris(page, rightId)
    const activeBefore = await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())

    await focusSessionList(page, workbench)
    await parkCursorOnInactiveRow(page)
    expect(await activeElementGroup(page)).toBeNull()

    await page.keyboard.press('Enter')

    // 光标那一行就是留在左组的那个会话（只有两个会话），回车后焦点跟着它走。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveAcpSessionId()), { timeout: 20000 })
      .not.toBe(activeBefore)
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getActiveGroupId())).toBe(leftId)
    await expect.poll(() => activeElementGroup(page)).toBe(leftId)
    await expect.poll(() => workbench.getContextKey<boolean>('acpChatFocused')).toBe(true)
    // 两个组一个 tab 都没多——reveal 复用既有 tab，不开第二份。
    expect(await groupEditorUris(page, leftId)).toEqual(leftBefore)
    expect(await groupEditorUris(page, rightId)).toEqual(rightBefore)
  })

  test('Enter on the row of the session already open in front pulls focus back @regression', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    await newEchoSession(page, 1)
    const [groupId] = await groupIds(page)
    if (groupId === undefined) throw new Error('expected an editor group')
    const urisBefore = await groupEditorUris(page, groupId)

    // 焦点先待在列表里（会话 tab 已是该组 active editor、也是 active session）——
    // 这正是旧代码的静默 no-op 现场：setActive 同值，autorun 不重跑。
    await focusSessionList(page, workbench)
    await expect.poll(() => workbench.getContextKey<boolean>('acpChatFocused')).toBe(false)

    await page.keyboard.press('Enter')

    await expect.poll(() => workbench.getContextKey<boolean>('acpChatFocused')).toBe(true)
    await expect.poll(() => activeElementGroup(page)).toBe(groupId)
    expect(await workbench.getEditorGroupCount()).toBe(1)
    expect(await groupEditorUris(page, groupId)).toEqual(urisBefore)
  })
})
