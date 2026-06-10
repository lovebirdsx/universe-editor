/*---------------------------------------------------------------------------------------------
 *  Editor group switching smoke tests.
 *
 *  Covers:
 *   1. Ctrl+K chord horizontal navigation (FocusLeft / FocusRight)
 *   2. Ctrl+K chord vertical navigation (FocusAbove / FocusBelow)
 *   3. Monaco focus transfers after chord navigation (editorFocus ContextKey)
 *   4. editorPartMultipleEditorGroups ContextKey tracks group count
 *   5. MoveEditorToRightGroup creates a new group when no right neighbor exists
 *   6. MoveEditorToNextGroup cycles editor between existing groups
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'
import type { Page } from '@playwright/test'

// Move DOM focus out of the editor onto a real focusable element (an activity
// bar item). The project's Ctrl+K chord navigation is only authoritative while
// no editor widget holds focus — when an editor is focused, Monaco parses Ctrl+K
// first (focus-gated dual listener). Focusing a non-editor element makes
// editorFocus settle false; we focus a real element rather than document.body so
// FileEditor's blur-reclaim (which only fires when focus fell to body) bows out.
async function defocusEditor(page: Page, workbench: WorkbenchPO): Promise<void> {
  await page.focus('[data-testid="activitybar-item-workbench.view.explorer"]')
  await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(false)
}

test.describe('@p0 editor group focus — Ctrl+K chord navigation', () => {
  test('Ctrl+K Ctrl+Left and Ctrl+K Ctrl+Right switch focus between horizontal groups', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // Open untitled A, record its URI.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const uriA = await workbench.getActiveEditorUri()
    expect(uriA).toMatch(/^untitled:/)

    // Split right: copies A into a new right group, right group becomes active.
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    // Open untitled B in the now-active right group.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    const uriB = await workbench.getActiveEditorUri()
    expect(uriB).toMatch(/^untitled:/)
    expect(uriB).not.toBe(uriA)

    // Ctrl+K Ctrl+Left → focus moves to the left group (editor A).
    await page.bringToFront()
    await defocusEditor(page, workbench)
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+ArrowLeft')
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriA)

    // Ctrl+K Ctrl+Right → focus returns to the right group (editor B).
    await defocusEditor(page, workbench)
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+ArrowRight')
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriB)
  })

  test('Ctrl+K Ctrl+Up and Ctrl+K Ctrl+Down switch focus between vertical groups', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // Open untitled A, record its URI.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const uriA = await workbench.getActiveEditorUri()
    expect(uriA).toMatch(/^untitled:/)

    // Split down: copies A into a new bottom group, bottom group becomes active.
    await workbench.runCommand('workbench.action.splitEditorDown')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    // Open untitled B in the now-active bottom group.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    const uriB = await workbench.getActiveEditorUri()
    expect(uriB).toMatch(/^untitled:/)
    expect(uriB).not.toBe(uriA)

    // Ctrl+K Ctrl+Up → focus moves to the top group (editor A).
    await page.bringToFront()
    await defocusEditor(page, workbench)
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+ArrowUp')
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriA)

    // Ctrl+K Ctrl+Down → focus returns to the bottom group (editor B).
    await defocusEditor(page, workbench)
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+ArrowDown')
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriB)
  })

  test('Monaco receives DOM focus (editorFocus) after Ctrl+K chord navigation', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()

    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()

    // Navigate left; after the switch editorFocus must be true (Monaco focused).
    await page.bringToFront()
    await defocusEditor(page, workbench)
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+ArrowLeft')
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
  })
})

test.describe('@p0 editor group — editorPartMultipleEditorGroups context key', () => {
  test('context key reflects whether more than one editor group is open', async ({ workbench }) => {
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()

    // Single group: context key must be false.
    await expect
      .poll(() => workbench.getContextKey<boolean>('editorPartMultipleEditorGroups'))
      .toBe(false)

    // Split right → two groups.
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    await expect
      .poll(() => workbench.getContextKey<boolean>('editorPartMultipleEditorGroups'))
      .toBe(true)

    // Close the active editor in the right group; the empty group auto-removes.
    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(1)
    await expect
      .poll(() => workbench.getContextKey<boolean>('editorPartMultipleEditorGroups'))
      .toBe(false)
  })
})

test.describe('@p1 editor group move — MoveEditorToRightGroup', () => {
  test('creates a new right group and moves the active editor into it', async ({ workbench }) => {
    await workbench.waitForRestored()

    // Two editors in a single group; B is active.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    const uriA = await workbench.getActiveEditorUri()

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    const uriB = await workbench.getActiveEditorUri()
    expect(uriB).not.toBe(uriA)

    expect(await workbench.getEditorGroupCount()).toBe(1)

    // Move B into a new right group (no right neighbor yet → group is created).
    await workbench.runCommand('workbench.action.moveEditorToRightGroup')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    // The new right group is active and B is its active editor.
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriB)
  })
})

test.describe('@p0 command palette — Focus Group command transfers Monaco focus', () => {
  test('executing Focus Next Group via command palette moves Monaco DOM focus to the new group', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // Left group: open untitled A.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const uriA = await workbench.getActiveEditorUri()
    expect(uriA).toMatch(/^untitled:/)

    // Capture left group's data-group-id before the split (only one group exists).
    const leftGroupId = await page.evaluate(() => {
      return document.querySelector<HTMLElement>('[data-group-id]')?.dataset['groupId'] ?? null
    })
    expect(leftGroupId).not.toBeNull()

    // Split right → right group becomes active.
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    // Open untitled B in the right group.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    const uriB = await workbench.getActiveEditorUri()
    expect(uriB).not.toBe(uriA)

    // Confirm Monaco in the right group has DOM focus before opening the palette.
    await workbench.runCommand('workbench.action.focusActiveEditorGroup')
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)

    // Open command palette via fire-and-forget — showCommands awaits user input
    // and would deadlock if we awaited it directly.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showCommands')
    })
    await workbench.quickInput.waitForVisible()

    // Type the command name and confirm with Enter.
    await page.keyboard.type('Focus Next Group')
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    // After the palette closes, Monaco in the left group (next with wrap) must have DOM focus.
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
    // The active editor must have moved to the left group.
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriA)
    // DOM-level check: the focused element must be inside the LEFT group's container,
    // not the right group that was active when the palette was opened.
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const active = document.activeElement
          return active?.closest<HTMLElement>('[data-group-id]')?.dataset['groupId'] ?? null
        })
      })
      .toBe(leftGroupId)
  })
})

test.describe('@p1 editor group move — MoveEditorToNextGroup', () => {
  test('moves the active editor from its group into the next group', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // Set up: group 1 has A and B (B active); group 2 has a copy of B.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    const uriA = await workbench.getActiveEditorUri()

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    const uriB = await workbench.getActiveEditorUri()

    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
    // Right group is active; open another untitled C to distinguish it from left.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    const uriC = await workbench.getActiveEditorUri()
    expect(uriC).not.toBe(uriA)
    expect(uriC).not.toBe(uriB)

    // Navigate to the left group so it is active, with B as the active editor
    // (B was active in the left group before the split).
    await page.bringToFront()
    await defocusEditor(page, workbench)
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+ArrowLeft')
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriB)

    // Move the active editor (B) from the left group to the next group (right).
    await workbench.runCommand('workbench.action.moveEditorToNextGroup')
    // Right group is now active; the moved editor B should be active there.
    await expect.poll(() => workbench.getActiveEditorUri()).toBe(uriB)
    // Left group still exists with A; total group count remains 2.
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
  })
})
