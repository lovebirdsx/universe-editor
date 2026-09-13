/*---------------------------------------------------------------------------------------------
 *  Session list keyboard navigation (Sessions view) (@p1).
 *
 *  Only e2e can prove this end to end. The list moved to the shared
 *  `useFlatListNavigation`, and the piece unit tests cannot reach is the wiring
 *  around it: `SessionListPanel` registering the `<ul>` with the focusable
 *  registry, so `LayoutService.focusView('workbench.view.sessions.main')` puts DOM
 *  focus on the list, and `FocusContextKeyContribution` deriving
 *  `focusedView` from the DOM — which is what a future
 *  `focusedView == 'workbench.view.sessions.main'` keybinding would be gated on.
 *  Same reasoning as smoke.outlineKeyboard's header.
 *
 *  Before the migration none of this held: the `<ul>` had no role and no
 *  tabIndex, every `<li>` was its own tab stop, and the view registered no
 *  focusable element at all.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'
import type { Locator, Page } from '@playwright/test'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const SESSIONS_VIEW_ID = 'workbench.view.sessions.main'

/** Row ids the arrow keys are currently on, read off `aria-selected`. */
const cursorRowIds = () => {
  const list = document.querySelector('[role="listbox"][aria-label="Sessions"]')
  if (!list) return ['<no-session-list>']
  return Array.from(list.querySelectorAll('li[aria-selected="true"]')).map(
    (el) => (el as HTMLElement).dataset['testid'] ?? '',
  )
}

/**
 * Whether the row under the cursor is also the open session. `data-active` is
 * the row's own answer, so this needs no mapping between the local session id
 * the probe reports and the durable id the row is keyed by.
 */
const cursorRowIsActive = () => {
  const row = document.querySelector(
    '[role="listbox"][aria-label="Sessions"] li[aria-selected="true"]',
  )
  return row instanceof HTMLElement && row.dataset['active'] === 'true'
}

/**
 * Focus the Sessions view and wait for the focus to actually stick.
 *
 * A freshly opened session's editor claims focus for its prompt input a beat
 * after `newSession` resolves, so a single focusView can be silently undone —
 * and so can one that merely *looks* like it landed, if the steal is still in
 * flight. Re-issuing the command and re-checking a beat later makes the
 * assertion "focus survived the window" rather than "focus happened once".
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

test.describe('@p1 agents session list keyboard navigation', () => {
  test('focusView lands on the list and the arrow keys drive its cursor', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // Two sessions, so there is something to navigate between. The default chat
    // location is 'editor', which is exactly when the Sessions view shows the list.
    for (const _ of [0, 1]) {
      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.agent.newSession')
      })
    }
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 20000 })
      .toBe(2)

    // The wiring under test: focusView resolves through the focusable registry
    // to the list container, and focusedView follows from the focused DOM node.
    const list = await focusSessionList(page, workbench)

    // Rows are data, not tab stops — the container is the single focusable.
    expect(await list.locator('li[tabindex]').count()).toBe(0)

    // Landing focus seeds the cursor on the first row, so the arrows have
    // somewhere to start. It is still only a cursor: the active session (which
    // chat is open) is tracked separately, and opening the view resumes nothing.
    const first = await page.evaluate(cursorRowIds)
    expect(first).toHaveLength(1)

    await page.keyboard.press('ArrowDown')
    const second = await page.evaluate(cursorRowIds)
    expect(second).toHaveLength(1)
    expect(second).not.toEqual(first)

    await page.keyboard.press('ArrowUp')
    expect(await page.evaluate(cursorRowIds)).toEqual(first)

    await page.keyboard.press('End')
    expect(await page.evaluate(cursorRowIds)).toEqual(second)
    await page.keyboard.press('Home')
    expect(await page.evaluate(cursorRowIds)).toEqual(first)
  })

  test('Enter opens the session under the cursor', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    for (const _ of [0, 1]) {
      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.agent.newSession')
      })
    }
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 20000 })
      .toBe(2)

    const activeBefore = await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())
    expect(activeBefore).toBeTruthy()

    await focusSessionList(page, workbench)

    // Park the cursor on a row that is NOT the open session, so pressing Enter
    // has an observable effect. `data-active` is the row's own view of that, so
    // the check needs no id mapping between local and agent-issued ids.
    await expect
      .poll(async () => {
        const onActive = await page.evaluate(cursorRowIsActive)
        if (onActive) await page.keyboard.press('ArrowDown')
        return onActive
      })
      .toBe(false)

    // The bug: with Enter unbound on the list, this did nothing at all and the
    // only way to open a session was the mouse.
    await page.keyboard.press('Enter')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveAcpSessionId()), { timeout: 20000 })
      .not.toBe(activeBefore)
    // …and it is the row the cursor was on that opened.
    await expect.poll(() => page.evaluate(cursorRowIsActive)).toBe(true)
  })

  test('the ContextMenu key opens one row-anchored menu', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 20000 })
      .toBe(1)

    await focusSessionList(page, workbench)

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ContextMenu')

    // Exactly one: Chromium re-dispatches a detail-0 contextmenu on keyup that
    // keydown's preventDefault cannot cancel, and the hook must swallow it —
    // see smoke.explorerKeyboardContextMenu for the full contract.
    const menus = page.getByRole('menu')
    await expect(menus).toHaveCount(1)
    await expect(menus.getByRole('menuitem', { name: 'Pin Session' })).toBeVisible()

    // A keyboard user has no pointer to aim, so the first entry opens highlighted
    // while DOM focus stays on the list.
    await expect(page.locator('[role="menuitem"][data-active]')).toHaveCount(1)
    await expect(page.getByRole('listbox', { name: 'Sessions' })).toHaveAttribute(
      'data-focused',
      'true',
    )

    await page.keyboard.press('Escape')
    await expect(menus).toHaveCount(0)
  })
})
