/*---------------------------------------------------------------------------------------------
 *  Editor group lock smoke tests.
 *
 *  Covers:
 *   1. Closing the last editor of a locked group auto-unlocks it, so the next
 *      open lands back in that group instead of spawning a fresh one
 *   2. The lock survives a close that leaves editors behind (no over-unlock)
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p0 editor group lock', () => {
  test('closing the last editor unlocks the group and the next open reuses it', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const group = await workbench.getActiveGroupId()

    await workbench.runCommand('workbench.action.toggleEditorGroupLock')
    await expect.poll(() => workbench.getContextKey<boolean>('activeEditorGroupLocked')).toBe(true)

    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect.poll(() => workbench.getContextKey<boolean>('activeEditorGroupLocked')).toBe(false)
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(1)

    // The regression: an empty group that stayed locked would send this open
    // into a brand-new group, leaving the empty one behind as a dead pane.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(1)
    await expect.poll(() => workbench.getActiveGroupId()).toBe(group)
  })

  test('the lock survives a close that leaves editors behind', async ({ workbench }) => {
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    // A second tab in the right group, so closing one still leaves an editor.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await workbench.runCommand('workbench.action.toggleEditorGroupLock')
    await expect.poll(() => workbench.getContextKey<boolean>('activeEditorGroupLocked')).toBe(true)
    const group = await workbench.getActiveGroupId()

    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect.poll(() => workbench.getContextKey<boolean>('activeEditorGroupLocked')).toBe(true)
    await expect.poll(() => workbench.getActiveGroupId()).toBe(group)
  })
})
