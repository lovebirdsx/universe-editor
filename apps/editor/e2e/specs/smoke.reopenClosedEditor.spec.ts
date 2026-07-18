/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Ctrl+Shift+T reopens non-text editors correctly (P1).
 *
 *  Reproduces the bug where reopening a closed non-text editor (e.g. Settings)
 *  via Ctrl+Shift+T created an empty FileEditorInput instead of the original editor.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p1 reopen closed editor (Ctrl+Shift+T)', () => {
  test('reopens a Settings editor with the correct type @regression', async ({ workbench }) => {
    await workbench.waitForRestored()

    // Open the Settings editor
    await workbench.runCommand('workbench.action.openSettings')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 5000,
      })
      .toBe('settings')

    // Close it
    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 5000,
      })
      .not.toBe('settings')

    // Reopen via Ctrl+Shift+T — previously reopened as a blank FileEditorInput (typeId='file')
    await workbench.runCommand('workbench.action.reopenClosedEditor')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 5000,
      })
      .toBe('settings')
  })

  test('reopens a diff editor with the correct type @regression', async ({ workbench }) => {
    await workbench.waitForRestored()

    // Open a diff via the internal command (as p4/git SCM double-click does), pinned.
    await workbench.page.evaluate(() =>
      window.__E2E__!.runCommand('_workbench.openDiff', {
        originalUri: 'file:///reopen-diff-test.txt',
        original: 'line one\nline two\n',
        modified: 'line one\nline TWO\n',
        pinned: true,
      }),
    )
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 5000,
      })
      .toBe('diff')

    // Close it
    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 5000,
      })
      .not.toBe('diff')

    // Reopen — previously dropped because DiffEditorInput lacked serialize/deserialize.
    await workbench.runCommand('workbench.action.reopenClosedEditor')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 5000,
      })
      .toBe('diff')

    // The reopened diff must still show the ORIGINAL two sides — not two identical
    // (empty) panes. The sides here are passed-by-value text with no disk/SCM
    // backing, so a "re-fetch on restore" strategy rebuilds them as empty → the two
    // panes collapse to the same content and the diff vanishes. Guard the content.
    // Poll: the diff's Monaco models mount asynchronously after the input opens.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.modified), {
        timeout: 5000,
      })
      .toBe('line one\nline TWO\n')
    const content = await workbench.page.evaluate(() => window.__E2E__!.getActiveDiffContent())
    expect(content?.original).toBe('line one\nline two\n')
    expect(content?.original).not.toBe(content?.modified)
  })

  test('reopens a PREVIEW diff evicted in-place by single-clicking another file @regression', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()

    // Single-click in the SCM list opens a diff into the group's single PREVIEW
    // slot (pinned:false). Clicking a second file replaces the first in-place —
    // the evicted preview fires 'previewReplace', never 'close', so it used to be
    // dropped from the reopen stack and Ctrl+Shift+T could not bring it back.
    await workbench.page.evaluate(() =>
      window.__E2E__!.runCommand('_workbench.openDiff', {
        originalUri: 'file:///preview-diff-a.txt',
        original: 'A base\n',
        modified: 'A edited\n',
        pinned: false,
      }),
    )
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 5000,
      })
      .toBe('diff')

    // Single-click another file → replaces the preview diff of A in-place.
    await workbench.page.evaluate(() =>
      window.__E2E__!.runCommand('_workbench.openDiff', {
        originalUri: 'file:///preview-diff-b.txt',
        original: 'B base\n',
        modified: 'B edited\n',
        pinned: false,
      }),
    )

    // Reopen — must bring back diff A (the evicted preview), not diff B.
    await workbench.runCommand('workbench.action.reopenClosedEditor')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.modified), {
        timeout: 5000,
      })
      .toBe('A edited\n')
    const restored = await workbench.page.evaluate(() => window.__E2E__!.getActiveDiffContent())
    expect(restored?.original).toBe('A base\n')
  })
})
