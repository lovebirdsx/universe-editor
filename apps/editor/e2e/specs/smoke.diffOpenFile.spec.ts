/*---------------------------------------------------------------------------------------------
 *  Diff editor "Open File" (@p1).
 *
 *  Shift+Alt+Y toggles: open the diff from a file, press it again inside the diff
 *  to come back to the file. The return leg is gated on `diffEditorHasOpenableFile`,
 *  which the per-group scoped context-key service also sets — but keybindings and
 *  Action2 preconditions resolve against the ROOT service, so a scoped-only key
 *  reads as unset and the shortcut silently dies while the title-bar button keeps
 *  working. This spec asserts through the probe, which reads the root service.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test.describe('@p1 diff editor open file', () => {
  test('returns to the source file, and stays unavailable for a blob diff', async ({
    workbench,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ue2-diffopenfile-'))
    const notePath = join(dir, 'note.md')
    writeFileSync(notePath, 'working\n', 'utf8')

    await workbench.waitForRestored()
    await workbench.openWorkspace(dir)

    const fileUri = pathToFileURL(notePath).toString()
    await workbench.runCommand('_workbench.openDiff', {
      title: 'note.md (Working Tree)',
      originalUri: fileUri,
      original: 'head\n',
      modified: 'working\n',
      openableUri: fileUri,
      liveModified: true,
      pinned: true,
    })

    await expect
      .poll(() => workbench.getContextKey<boolean>('isInDiffEditor'), { timeout: 10_000 })
      .toBe(true)
    await expect
      .poll(() => workbench.getContextKey<boolean>('diffEditorHasOpenableFile'), {
        timeout: 10_000,
      })
      .toBe(true)

    await workbench.runCommand('workbench.action.diffEditor.openFile')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
        timeout: 10_000,
      })
      .toContain('note.md')
    await expect
      .poll(() => workbench.getContextKey<boolean>('isInDiffEditor'), { timeout: 10_000 })
      .toBe(false)

    // A diff with no source file behind it (depot / revision blob, Explorer
    // cross-file compare) must not offer Open File. Distinct originalUri on
    // purpose: _workbench.openDiff dedupes by it and reuses the existing input,
    // which would keep the openableResource from the first diff.
    const blobPath = join(dir, 'blob.md')
    await workbench.runCommand('_workbench.openDiff', {
      title: 'blob.md@3 ↔ @4',
      originalUri: pathToFileURL(blobPath).toString(),
      original: 'r3\n',
      modified: 'r4\n',
      pinned: true,
    })

    await expect
      .poll(() => workbench.getContextKey<boolean>('isInDiffEditor'), { timeout: 10_000 })
      .toBe(true)
    await expect
      .poll(() => workbench.getContextKey<boolean>('diffEditorHasOpenableFile'), {
        timeout: 10_000,
      })
      .toBe(false)
  })
})
