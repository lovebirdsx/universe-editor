/*---------------------------------------------------------------------------------------------
 *  Keyboard resize of the editor area (Ctrl+Shift+Alt+arrows).
 *
 *  Covers:
 *   1. Two side-by-side groups with every view closed: the shortcut moves the
 *      split between them by exactly RESIZE_STEP pixels (the reported bug — with
 *      no sidebar visible the shortcut used to be a silent no-op)
 *   2. Stacked groups: the height binding moves the row split
 *   3. A lone group still falls back to resizing the chrome
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

/** Must match RESIZE_STEP in renderer/services/layout/layoutConstraints.ts. */
const RESIZE_STEP = 50

function layoutSizes(page: Page) {
  return page.evaluate(() => window.__E2E__!.getLayoutSizes())
}

/** `toggleSidebarVisibility` is a toggle, so fire it only while it is visible. */
async function ensureSideBarHidden(workbench: WorkbenchPO): Promise<void> {
  await expect
    .poll(async () => {
      const visible = await workbench.getContextKey<boolean>('sideBarVisible')
      if (visible) await workbench.runCommand('workbench.action.toggleSidebarVisibility')
      return visible
    })
    .toBe(false)
}

async function focusGroup(workbench: WorkbenchPO, command: string): Promise<void> {
  await workbench.runCommand(command)
  await expect
    .poll(() => workbench.getContextKey<boolean>('editorAreaFocus'), {
      message: 'the shortcut only fires while the editor area holds focus',
    })
    .toBe(true)
}

test.describe('@p0 keyboard resize of the focused editor group', () => {
  test('Ctrl+Shift+Alt+Right moves the split between two side-by-side groups', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    // The reported precondition: every view closed, so the centre column has no
    // sidebar left to trade width with.
    await ensureSideBarHidden(workbench)
    await focusGroup(workbench, 'workbench.action.focusLeftGroup')

    const before = await workbench.getEditorGroupsLayout()
    expect(before.groups).toHaveLength(2)
    const left = before.groups[0]!
    const right = before.groups[1]!
    expect(left.active).toBe(true)
    expect(left.width).toBeGreaterThan(0)
    const chromeBefore = await layoutSizes(page)

    await page.keyboard.press('Control+Shift+Alt+ArrowRight')

    await expect
      .poll(async () => (await workbench.getEditorGroupsLayout()).groups[0]!.width, {
        message: 'the focused group should grow by exactly one resize step',
      })
      .toBeCloseTo(left.width + RESIZE_STEP, 0)

    const after = await workbench.getEditorGroupsLayout()
    expect(after.groups.map((group) => group.id)).toEqual([left.id, right.id])
    expect(after.groups[1]!.width).toBeCloseTo(right.width - RESIZE_STEP, 0)
    expect(after.groups[1]!.id).toBe(right.id)
    // The chrome never moved: the pixels came from the editor grid, not from the
    // sidebar fallback path.
    expect(await layoutSizes(page)).toEqual(chromeBefore)
  })

  test('Ctrl+Shift+Alt+Down moves the split between stacked groups', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await workbench.runCommand('workbench.action.splitEditorDown')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    await ensureSideBarHidden(workbench)
    await focusGroup(workbench, 'workbench.action.focusAboveGroup')

    const before = await workbench.getEditorGroupsLayout()
    const top = before.groups[0]!
    const bottom = before.groups[1]!
    expect(top.height).toBeGreaterThan(0)

    await page.keyboard.press('Control+Shift+Alt+ArrowDown')

    await expect
      .poll(async () => (await workbench.getEditorGroupsLayout()).groups[0]!.height)
      .toBeCloseTo(top.height + RESIZE_STEP, 0)
    const after = await workbench.getEditorGroupsLayout()
    expect(after.groups[1]!.height).toBeCloseTo(bottom.height - RESIZE_STEP, 0)
    expect(after.groups[0]!.width).toBeCloseTo(top.width, 0)
  })

  test('a lone group still resizes the workbench chrome', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.showExplorer()
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    expect(await workbench.getEditorGroupCount()).toBe(1)
    await focusGroup(workbench, 'workbench.action.focusActiveEditorGroup')

    const before = await layoutSizes(page)
    // The secondary sidebar is hidden by default, so the primary absorbs the change.
    expect(await workbench.getContextKey<boolean>('secondarySideBarVisible')).toBe(false)

    await page.keyboard.press('Control+Shift+Alt+ArrowRight')

    await expect
      .poll(async () => (await layoutSizes(page)).sidebar, {
        message: 'with no sibling group the sidebar keeps its old behaviour',
      })
      .toBe(before.sidebar - RESIZE_STEP)
  })
})
