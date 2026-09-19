/*---------------------------------------------------------------------------------------------
 *  Ctrl+Tab switcher: editors and views in one recency list (P0).
 *
 *  验证 quick-navigate 全流程：Ctrl+Tab 打开后处于锁定态（输入框只读 + 底部提示），松开
 *  Ctrl 直接打开高亮项，先按 Enter 才交还输入权用于过滤；视图行不可移除；没有编辑器打开
 *  时仍可弹出（precondition 已放宽）。
 *--------------------------------------------------------------------------------------------*/

import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/sharedApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'
import { waitForRecentTargetHead } from '../pages/recentTargets.js'

const SWITCH_COMMAND = 'workbench.action.quickOpenRecentEditor'
// AI Debug is the focus subject rather than Explorer: with no folder open the
// Explorer tree registers no focusable element, so `focusView` can only reach
// its Part and `focusedView` stays empty (pre-existing, unrelated to the
// switcher). AI Debug's list registers unconditionally — same reasoning as
// smoke.paneCompositeTabFocus.spec.ts.
const AI_DEBUG_VIEW = 'workbench.view.aiDebug.main'

/** Ctrl+Tab as the keybinding fires it, with Ctrl left DOWN — releasing it accepts
 *  the highlighted row, so tests that want to keep the picker open must pass it
 *  through `unlockSwitcher` or close it with `dismissSwitcher` first. */
async function openSwitcherHoldingCtrl(page: Page, workbench: WorkbenchPO): Promise<void> {
  await page.keyboard.down('Control')
  await page.evaluate((id) => {
    void window.__E2E__!.runCommand(id)
  }, SWITCH_COMMAND)
  await workbench.quickInput.waitForVisible()
}

/** Enter is the only way out of the locked state; it hands the field over without
 *  accepting, so Ctrl can then be released without opening anything. */
async function unlockSwitcher(page: Page, workbench: WorkbenchPO): Promise<void> {
  await page.keyboard.press('Enter')
  await expect(workbench.quickInput.input).not.toHaveAttribute('readonly', '')
  await expect(workbench.quickInput.hint).toBeHidden()
}

/** Close without accepting, then let go of the modifier (the panel is gone by then,
 *  so the release cannot open a row — and the shared window is left with no key held). */
async function dismissSwitcher(page: Page, workbench: WorkbenchPO): Promise<void> {
  await page.keyboard.press('Escape')
  await workbench.quickInput.waitForHidden()
  await page.keyboard.up('Control')
}

/** The switcher in its post-Enter state: Ctrl released, field editable, the picker
 *  behaving like any other. */
async function openSwitcherForTyping(page: Page, workbench: WorkbenchPO): Promise<void> {
  await openSwitcherHoldingCtrl(page, workbench)
  await unlockSwitcher(page, workbench)
  await page.keyboard.up('Control')
}

/**
 * Narrow the list to one row by typing, then confirm it is the highlighted one.
 * Requires the switcher to be unlocked (`openSwitcherForTyping`). Typing rather
 * than Tab-walking because the list is recency-ordered — its length and shape
 * depend on what earlier tests in the shared window touched, so no fixed number
 * of Tab presses reaches a given row.
 */
async function selectOnlyRow(page: Page, workbench: WorkbenchPO, query: string): Promise<Locator> {
  await page.keyboard.type(query)
  const rows = workbench.quickInput.dialog.getByRole('option')
  await expect.poll(() => rows.count()).toBe(1)
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
  return rows.first()
}

test.describe('@p0 quick open recent targets', () => {
  // Every test drives focus into Quick Input right after startup; the one-shot
  // bootstrap focus restore would otherwise steal it back mid-test.
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForBootstrapFocusSettled()
  })

  // A failed assertion inside a helper skips its `up('Control')`, and Playwright
  // keeps the pressed key on the Page — which the shared fixture reuses across
  // tests. Release it here so one failure cannot turn every later keystroke in
  // this worker into a Ctrl+<key> chord.
  test.afterEach(async ({ page }) => {
    await page.keyboard.up('Control')
  })

  test('lists views alongside editors', async ({ page, workbench }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()

    await openSwitcherHoldingCtrl(page, workbench)

    // Views are listed even when never focused this session.
    await expect(workbench.quickInput.dialog.getByRole('option', { name: /Files/ })).toBeVisible()

    await dismissSwitcher(page, workbench)
  })

  test('opens without an editor open', async ({ page, workbench }) => {
    // Previously gated on `editorIsOpen`, so this could not fire at all.
    await workbench.runCommand('workbench.action.closeAllEditors')
    await expect.poll(() => workbench.getContextKey<boolean>('editorIsOpen')).toBe(false)

    await openSwitcherHoldingCtrl(page, workbench)
    await expect(workbench.quickInput.dialog.getByRole('option', { name: /Files/ })).toBeVisible()

    await dismissSwitcher(page, workbench)
  })

  // The gesture the switcher exists for: Ctrl+Tab, release, done. The picker opens
  // one step away from where the user is, so the highlighted row is the target they
  // came from.
  test('releasing Ctrl opens the highlighted row', async ({ page, workbench }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const previous = await workbench.getActiveEditorUri()
    expect(previous).toBeDefined()

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect.poll(() => workbench.getActiveEditorUri()).not.toBe(previous)
    const current = await workbench.getActiveEditorUri()
    expect(current).toBeDefined()
    // 高亮行是「当前项在列表里的下一项」，所以当前编辑器必须先坐稳 head。
    await waitForRecentTargetHead(page, 'editor', current!)

    await openSwitcherHoldingCtrl(page, workbench)
    await expect(workbench.quickInput.dialog.locator('[aria-selected="true"]')).toContainText(
      previous!.split('/').pop() ?? '',
    )

    await page.keyboard.up('Control')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(previous)
  })

  // Holding Ctrl keeps the field read-only (typed characters must not land in it),
  // and Enter is what hands it over. Until then a release opens the row, so this is
  // also the regression guard for "the filter box became unreachable".
  test('stays locked until Enter, then filters by typing', async ({ page, workbench }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()

    await openSwitcherHoldingCtrl(page, workbench)
    await expect(workbench.quickInput.input).toHaveAttribute('readonly', '')
    await expect(workbench.quickInput.hint).toBeVisible()

    await unlockSwitcher(page, workbench)
    await page.keyboard.up('Control')
    // Unlocked: releasing the modifier no longer opens anything.
    await expect(workbench.quickInput.dialog).toBeVisible()

    await page.keyboard.type('Terminal')
    const rows = workbench.quickInput.dialog.getByRole('option')
    await expect.poll(() => rows.count()).toBeGreaterThan(0)
    await expect(rows.first()).toContainText('Terminal')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('selecting a view row focuses that view', async ({ page, workbench }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await workbench.focusActiveEditorGroup()

    await openSwitcherForTyping(page, workbench)
    await selectOnlyRow(page, workbench, 'AI Debug')

    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect.poll(() => workbench.getContextKey<string>('focusedView')).toBe(AI_DEBUG_VIEW)
  })

  test('view rows cannot be removed from the list', async ({ page, workbench }) => {
    await openSwitcherForTyping(page, workbench)

    const filesRow = await selectOnlyRow(page, workbench, 'Timeline')

    // Ctrl+X closes a focused editor row; a view has nothing to close, so the
    // row must survive.
    await page.keyboard.press('Control+x')
    await expect(filesRow).toBeVisible()

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('selecting an editor row still activates that editor', async ({ page, workbench }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const first = await workbench.getActiveEditorUri()
    expect(first).toBeDefined()

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect.poll(() => workbench.getActiveEditorUri()).not.toBe(first)

    await openSwitcherForTyping(page, workbench)
    await selectOnlyRow(page, workbench, first!.split('/').pop() ?? '')

    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect.poll(() => workbench.getActiveEditorUri()).toBe(first)
  })

  // The whole point of tracking views in the MRU: a view you just worked in
  // must outrank ones you never touched. Guards a bug where the focus stack
  // silently rejected every sidebar Part, freezing the list in registration
  // order — see closestPartId in FocusStackService.
  test('a focused view moves to the head of the recency list', async ({ page, workbench }) => {
    for (const container of ['workbench.view.scm', 'workbench.view.search']) {
      const tab = page.getByTestId(`activitybar-item-${container}`)
      await expect(tab).toBeVisible()
      await tab.click()
    }
    await expect
      .poll(() => workbench.getContextKey<string>('focusedView'))
      .toBe('workbench.view.search.results')
    await waitForRecentTargetHead(page, 'view', 'workbench.view.search.results')

    // Read-only assertions: stay locked (Ctrl held) so the picker cannot accept and
    // close underneath the labels being collected.
    await openSwitcherHoldingCtrl(page, workbench)

    const labels = await workbench.quickInput.dialog.getByRole('option').allTextContents()
    const idxOf = (prefix: string) => labels.findIndex((l) => l.startsWith(prefix))
    // Search was focused last, SCM before it, Outline never — that is the order.
    expect(idxOf('Search')).toBe(0)
    expect(idxOf('Source Control')).toBeGreaterThan(0)
    expect(idxOf('Source Control')).toBeLessThan(idxOf('Outline'))

    await dismissSwitcher(page, workbench)
  })

  // These six used to be permanently stuck at the tail of the recency list:
  // none of them registers a focusable element in its default state (MCP
  // Servers and Output register none at all; Timeline / Commit Changes /
  // Session Changes register a tree only once they have content), so focusing
  // them left DOM focus on the Part and the focus stack never saw the view.
  // ViewBody now makes every view body a fallback focus target.
  //
  // Driven through the switcher itself rather than a focus command: that is the
  // user's actual path, and it proves the full round trip (pick → focusView →
  // focus lands inside [data-view-id] → MRU head).
  for (const { view, label } of [
    { view: 'workbench.view.timeline.main', label: 'Timeline' },
    { view: 'workbench.view.scm.commitChanges', label: 'Commit Changes' },
    { view: 'workbench.view.sessionChanges.main', label: 'Session Changes' },
    { view: 'workbench.view.sessions.mcp', label: 'MCP Servers' },
    { view: 'workbench.view.output.main', label: 'Output' },
    { view: 'workbench.view.terminal.main', label: 'Terminal' },
  ]) {
    test(`${label} enters the recency list once focused`, async ({ page, workbench }) => {
      await openSwitcherForTyping(page, workbench)
      await selectOnlyRow(page, workbench, label)
      await page.keyboard.press('Enter')
      await workbench.quickInput.waitForHidden()

      await expect.poll(() => workbench.getContextKey<string>('focusedView')).toBe(view)
      await waitForRecentTargetHead(page, 'view', view)

      // Reopening must now show it at the head — the switcher opens one step
      // away from "here", so the current target is row 0.
      await openSwitcherHoldingCtrl(page, workbench)
      const labels = await workbench.quickInput.dialog.getByRole('option').allTextContents()
      expect(labels[0]).toContain(label)

      await dismissSwitcher(page, workbench)
    })
  }

  // A collapsed pane still renders its view — into a display:none subtree, which
  // the browser refuses to focus. So the element is in the registry, focus()
  // silently does nothing, and the view can never be switched to or reach the
  // MRU. focusView now expands it first. The loop above cannot catch this: e2e
  // starts with no persisted view state, so every pane is expanded.
  test('a collapsed view is expanded and still enters the recency list', async ({
    page,
    workbench,
  }) => {
    const TIMELINE = 'workbench.view.timeline.main'
    await page.evaluate((id) => window.__E2E__!.setViewCollapsed(id, true), TIMELINE)
    await expect
      .poll(() => page.evaluate((id) => window.__E2E__!.getViewCollapsed(id), TIMELINE))
      .toBe(true)

    await openSwitcherForTyping(page, workbench)
    await selectOnlyRow(page, workbench, 'Timeline')
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect
      .poll(() => page.evaluate((id) => window.__E2E__!.getViewCollapsed(id), TIMELINE))
      .toBe(false)
    await expect.poll(() => workbench.getContextKey<string>('focusedView')).toBe(TIMELINE)
    await waitForRecentTargetHead(page, 'view', TIMELINE)

    await openSwitcherHoldingCtrl(page, workbench)
    const labels = await workbench.quickInput.dialog.getByRole('option').allTextContents()
    expect(labels[0]).toContain('Timeline')

    await dismissSwitcher(page, workbench)
  })
})
