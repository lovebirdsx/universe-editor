/*---------------------------------------------------------------------------------------------
 *  Editable working-tree diff (@p1).
 *
 *  A diff whose right side IS the live working-tree file (same file, liveModified)
 *  must be editable: the right pane shares the file's Monaco model and Save writes
 *  it back to disk. A snapshot diff (liveModified omitted) must stay read-only —
 *  its right side is a frozen blob that editing must not clobber.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ORIGINAL = 'hello old\n'
const MODIFIED = 'hello world\n'
const EDITED = 'hello world EDITED\n'

test.describe('@p1 editable diff', () => {
  test('edits and saves the live working-tree side of a diff', async ({ workbench }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ue2-diffeditable-'))
    const notePath = join(dir, 'note.md')
    writeFileSync(notePath, MODIFIED, 'utf8')

    await workbench.waitForRestored()
    await workbench.openWorkspace(dir)

    const fileUri = pathToFileURL(notePath).toString()
    await workbench.runCommand('_workbench.openDiff', {
      title: 'note.md',
      originalUri: fileUri,
      original: ORIGINAL,
      modified: MODIFIED,
      openableUri: fileUri,
      liveModified: true,
      pinned: true,
    })

    // The working-tree diff's right side is the editable shared model.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveDiffEditable()), {
        timeout: 10_000,
      })
      .toEqual({ editable: true, dirty: false })

    // Drive a whole-file edit through the shared model (what typing would produce).
    await expect
      .poll(
        () =>
          workbench.page.evaluate(
            (text) => window.__E2E__!.setActiveDiffModifiedText(text),
            EDITED,
          ),
        { timeout: 10_000 },
      )
      .toBe(true)

    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveDiffEditable()?.dirty), {
        timeout: 10_000,
      })
      .toBe(true)

    // The Monaco diff model is only registered once the editor mounts; poll before reading.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveDiffContent()), {
        timeout: 10_000,
      })
      .toBeTruthy()
    const content = await workbench.page.evaluate(() => window.__E2E__!.getActiveDiffContent())
    expect(content?.modified).toBe(EDITED)
    expect(content?.original).toBe(ORIGINAL)

    await workbench.runCommand('workbench.action.files.save')

    await expect
      .poll(
        () =>
          workbench.page.evaluate((path) => window.__E2E__!.readWorkspaceFileText(path), notePath),
        { timeout: 10_000 },
      )
      .toBe(EDITED)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveDiffEditable()?.dirty), {
        timeout: 10_000,
      })
      .toBe(false)

    // Closing the tab disposes the input synchronously before React unmounts the
    // widget — the shared model must survive that hand-off and only be released
    // after the widget detaches (a disposed-while-attached throw is a regression).
    const pageErrors: string[] = []
    const onPageError = (err: Error) => pageErrors.push(String(err))
    workbench.page.on('pageerror', onPageError)
    await workbench.runCommand('workbench.action.closeActiveEditor')
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveDiffEditable()), {
        timeout: 10_000,
      })
      .toBeUndefined()
    workbench.page.off('pageerror', onPageError)
    expect(pageErrors).toEqual([])
  })

  test('a snapshot diff stays read-only', async ({ workbench }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ue2-diffeditable2-'))
    const notePath = join(dir, 'note.md')
    writeFileSync(notePath, MODIFIED, 'utf8')

    await workbench.waitForRestored()
    await workbench.openWorkspace(dir)

    const fileUri = pathToFileURL(notePath).toString()
    await workbench.runCommand('_workbench.openDiff', {
      title: 'note.md',
      originalUri: fileUri,
      original: ORIGINAL,
      modified: MODIFIED,
      openableUri: fileUri,
      pinned: true,
    })

    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveDiffEditable()), {
        timeout: 10_000,
      })
      .toEqual({ editable: false, dirty: false })

    // The shared model is not editable here: the probe refuses to mutate it.
    const wrote = await workbench.page.evaluate(
      (text) => window.__E2E__!.setActiveDiffModifiedText(text),
      EDITED,
    )
    expect(wrote).toBe(false)

    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveDiffContent()), {
        timeout: 10_000,
      })
      .toBeTruthy()
    const content = await workbench.page.evaluate(() => window.__E2E__!.getActiveDiffContent())
    expect(content?.modified).toBe(MODIFIED)
  })
})
