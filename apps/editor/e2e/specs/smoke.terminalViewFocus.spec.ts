/*---------------------------------------------------------------------------------------------
 *  Ctrl+Tab 切到 Terminal 视图后，键盘焦点必须落进 xterm（@regression）。
 *
 *  Bug：Ctrl+Tab 选中视图行走的是 LayoutService.focusView(viewId)，它经
 *  IFocusableRegistry 取该视图的焦点元素。TerminalView 从未注册 primary，注册表只剩
 *  ViewBody 的 fallback（tabIndex=-1 的容器 div），于是 focusView 把焦点停在容器上并
 *  判定成功返回 —— 1px 蓝框描着整个面板，敲键进不了终端（xterm 真正的焦点元素是
 *  term.textarea，即 .xterm-helper-textarea）。
 *
 *  为什么只有这一种状态能复现：TerminalInstance 的聚焦 effect 只在 `focused` prop
 *  （panelVisible && groupActive && id === activeId）翻转时跑。用户路径里实例早已是
 *  active、面板早已可见（focused 恒为 true），effect 不重跑，容器上的焦点就再没人接管。
 *  面板首次显示 / 新 spawn 终端都会翻转该 prop，所以那些路径看着是好的 —— 本用例必须
 *  先把焦点挪到编辑器，构造出「终端在屏幕上、键盘焦点在别处」这个前置状态。
 *
 *  冷启 fixture：PTY 属 main 进程状态，且这里要读真实 pty 输出来证明键真的到了终端。
 *--------------------------------------------------------------------------------------------*/

import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/electronApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

const SWITCH_COMMAND = 'workbench.action.quickOpenRecentEditor'
const TERMINAL_VIEW_ID = 'workbench.view.terminal.main'
const MARKER = '__E2E_TERMINAL_VIEW_FOCUS__'

/** Ctrl+Tab 解锁到可输入态的完整手势：Ctrl 按住打开、Enter 交还输入权、再松开 Ctrl
 *  （锁定态下松 Ctrl 会直接接受高亮行，所以必须先解锁）。 */
async function openSwitcherForTyping(page: Page, workbench: WorkbenchPO): Promise<void> {
  await page.keyboard.down('Control')
  await page.evaluate((id) => {
    void window.__E2E__!.runCommand(id)
  }, SWITCH_COMMAND)
  await workbench.quickInput.waitForVisible()
  await page.keyboard.press('Enter')
  await expect(workbench.quickInput.input).not.toHaveAttribute('readonly', '')
  await expect(workbench.quickInput.hint).toBeHidden()
  await page.keyboard.up('Control')
}

/** 打字把列表收窄到一行，并要求它就是高亮行。列表是 recency 序、行数随会话变化，
 *  所以不能用固定次数的 Tab 定位。 */
async function selectOnlyRow(page: Page, workbench: WorkbenchPO, query: string): Promise<Locator> {
  await page.keyboard.type(query)
  const rows = workbench.quickInput.dialog.getByRole('option')
  await expect.poll(() => rows.count()).toBe(1)
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
  return rows.first()
}

test.describe('@regression terminal view focus', () => {
  // 断言失败会跳过 helper 里的 up('Control')，而 Playwright 会把按住的键留在 Page 上。
  // 释放掉，别让一次失败污染这个 worker 里后续的每一次按键。
  test.afterEach(async ({ page }) => {
    await page.keyboard.up('Control')
  })

  test('Ctrl+Tab to the Terminal view puts keyboard focus in the xterm @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    // 启动期的 one-shot 焦点恢复晚于 Restored，不先等它就会被中途抢走焦点。
    await workbench.waitForBootstrapFocusSettled()

    const id = await page.evaluate(() => window.__E2E__!.terminalCreateInWorkspace())
    if (id === null) throw new Error('terminal was not created')

    await workbench.runCommand('workbench.action.terminal.toggleTerminal')
    await workbench.panel.waitForVisible()
    await workbench.panel.waitForActiveTab('workbench.view.terminal')
    await page.locator(`[data-terminal-id="${id}"] .xterm-rows`).waitFor({ state: 'attached' })

    // 前置状态：终端在屏幕上、键盘焦点在编辑器里。
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await workbench.focusActiveEditorGroup()
    // 反证：断言不是恒真 —— 此刻焦点确实不在任何终端宿主里。
    await expect.poll(() => workbench.getContextKey<boolean>('terminalFocus')).toBe(false)

    await openSwitcherForTyping(page, workbench)
    await selectOnlyRow(page, workbench, 'Terminal')
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    // 轨道 1：context key。
    await expect
      .poll(() => workbench.getContextKey<boolean>('terminalFocus'), { timeout: 10_000 })
      .toBe(true)
    await expect.poll(() => workbench.getContextKey<string>('focusedView')).toBe(TERMINAL_VIEW_ID)

    // 轨道 2：DOM 祖先链。焦点必须落在**这个**终端的宿主里 —— 停在 ViewBody
    // fallback 上时轨道 1 的 focusedView 同样成立，只有 terminalFocus 会留下 false。
    await expect.poll(() => workbench.getFocusedTerminalId()).toBe(id)

    // 轨道 3：用户可见的收益 —— 真键盘输入必须到达 pty。断言的是内核 tty 的立即
    // 回显（证明键从 xterm 走到了 pty），不是 shell 执行过（见 e2e/CLAUDE.md 案例 87）。
    await page.keyboard.type(`echo ${MARKER}`)
    await page.keyboard.press('Enter')
    await expect
      .poll(() => page.evaluate((tid) => window.__E2E__!.terminalReadBuffer(tid), id), {
        timeout: 10_000,
      })
      .toContain(MARKER)

    // The other half of the gesture, now that focus really does sit in the xterm:
    // Ctrl+Tab must still reach the global keybinding handler, or the user gets
    // stuck in the terminal. Only the modifier-less printable keys are reserved
    // for the text surface, so a chord like this one stays ours.
    await openSwitcherForTyping(page, workbench)
    await selectOnlyRow(page, workbench, 'Untitled')
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
    await expect.poll(() => workbench.getContextKey<boolean>('terminalFocus')).toBe(false)
  })
})
