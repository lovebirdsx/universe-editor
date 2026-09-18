/*---------------------------------------------------------------------------------------------
 *  Breadcrumbs smoke (P1).
 *
 *  Regression for "a background editor group's breadcrumbs show the FOCUSED
 *  group's symbol path": a split view renders one FileEditor — and therefore one
 *  breadcrumb bar — per group, and the outline service keeps one tracker per
 *  group, so the path above a group must come from THAT group's caret. The
 *  service used to follow only the global active editor, which made the left
 *  group's breadcrumbs mirror whatever the right group had scrolled to.
 *
 *  JSON symbols come from the in-renderer worker (no out-of-process LSP cold
 *  start), which keeps the spec cheap.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

/** `alphaChild` sits on line 3 of the 2-space-indented file below. */
const CHILD_LINE = 3

function writeWorkspace(): { dir: string; pathA: string; pathB: string } {
  const dir = mkTempDir('universe-editor-e2e-breadcrumbs-')
  const pathA = join(dir, 'a.json')
  const pathB = join(dir, 'b.json')
  writeFileSync(pathA, JSON.stringify({ alpha: { alphaChild: 1 } }, null, 2) + '\n')
  writeFileSync(pathB, JSON.stringify({ beta: { betaChild: 1 } }, null, 2) + '\n')
  const toFsPath = (p: string): string => p.replace(/\\/g, '/')
  return { dir: toFsPath(dir), pathA: toFsPath(pathA), pathB: toFsPath(pathB) }
}

function groupIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-group-id]')).map(
      (el) => el.dataset['groupId'] ?? '',
    ),
  )
}

/** The breadcrumb text of one group, e.g. "a.json alpha alphaChild". */
async function breadcrumbText(page: Page, groupId: string): Promise<string> {
  const crumbs = page.locator(`[data-group-id="${groupId}"] [data-testid="editor-breadcrumbs"]`)
  return (await crumbs.textContent()) ?? ''
}

/** Move DOM focus off the editor so the Ctrl+K chord navigation is authoritative. */
async function focusGroupLeft(page: Page, workbench: WorkbenchPO): Promise<void> {
  await page.focus('[data-testid="activitybar-item-workbench.view.explorer"]')
  await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(false)
  await page.keyboard.press('Control+k')
  await page.keyboard.press('Control+ArrowLeft')
}

async function focusGroupRight(page: Page, workbench: WorkbenchPO): Promise<void> {
  await page.focus('[data-testid="activitybar-item-workbench.view.explorer"]')
  await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(false)
  await page.keyboard.press('Control+k')
  await page.keyboard.press('Control+ArrowRight')
}

test.describe('@p1 breadcrumbs', () => {
  test("each editor group's breadcrumbs follow that group's caret @regression", async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    // Focus restore lands after waitForRestored(), and this spec drives focus itself.
    await workbench.waitForBootstrapFocusSettled()

    const { dir, pathA, pathB } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)

    // Open A in the only group, remember which one it is, then split right and
    // open B there — the split copies A into the new group and activates it.
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), pathA)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('a.json')
    const uriA = (await workbench.getActiveEditorUri())!
    await expect.poll(() => workbench.getContextKey<string>('activeEditorLanguageId')).toBe('json')

    const [leftId] = await groupIds(page)
    expect(leftId).toBeTruthy()
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    const rightId = (await groupIds(page)).find((id) => id !== leftId)
    expect(rightId).toBeTruthy()

    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), pathB)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('b.json')
    const uriB = (await workbench.getActiveEditorUri())!
    expect(uriB).not.toBe(uriA)

    // Put the LEFT group's caret inside `alphaChild`, then leave it in the
    // background by focusing the right group.
    await focusGroupLeft(page, workbench)
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriA)
    await page.evaluate((line) => window.__E2E__!.setActiveEditorCursor(line, 5), CHILD_LINE)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineActiveSymbol()), {
        timeout: 20000,
      })
      .toBe('alphaChild')

    await focusGroupRight(page, workbench)
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriB)
    await page.evaluate((line) => window.__E2E__!.setActiveEditorCursor(line, 5), CHILD_LINE)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineActiveSymbol()), {
        timeout: 20000,
      })
      .toBe('betaChild')

    // The focused group shows its own path…
    await expect.poll(() => breadcrumbText(page, rightId!)).toContain('betaChild')
    // …and the background group keeps showing ITS OWN, not the focused one's.
    await expect.poll(() => breadcrumbText(page, leftId!)).toContain('alphaChild')
    expect(await breadcrumbText(page, leftId!)).not.toContain('betaChild')
  })
})
