/*---------------------------------------------------------------------------------------------
 *  Shared file clipboard smoke (P1).
 *
 *  The main process owns the file clipboard (IFileClipboardService): the
 *  explorer cut/copy commands commit a snapshot {resources, isCut, source} to
 *  main memory + the OS clipboard, and every window reads that same snapshot on
 *  paste. These cases drive the real explorer commands with explicit target
 *  args (deterministic — no tree selection / DOM involved) and assert both the
 *  snapshot (via the readClipboardSnapshot probe) and the on-disk outcome.
 *
 *  Cold-launch fixture: the cross-window case needs a second BrowserWindow
 *  (main-process state), and the whole file shares one fixture. The pinned
 *  workspaceSeeder gives every case a known file + subdirectory.
 *
 *  Tagged @serial: every case writes the OS clipboard — a global resource
 *  shared by every Electron on the display. A parallel worker's write landing
 *  inside our copy→paste window would flip a >5s-later read from 'internal' to
 *  the other test's 'os' content (the ownership signature check fires once the
 *  grace window expires) — the same cross-worker race the ACP paste-image case
 *  documents (smoke.acpPasteImage.spec.ts).
 *
 *  NOT covered here: "another application overwrites the OS clipboard while we
 *  still own it → the snapshot degrades to source:'os'". That path needs a real
 *  OS-clipboard ownership fight — a >5s sleep after our write plus a second
 *  writer stealing the X11 selection, which headless CI cannot do reliably (and
 *  on Windows the CF_HDROP ownership battle is worse). The signature-mismatch
 *  degradation is already unit-tested in fileClipboardMainService.test.ts
 *  ("falls back to the os snapshot when the signature no longer matches").
 *  The os-source paste path itself (no ownership fight: an external app fills
 *  the clipboard before our first read) IS covered — the last case injects the
 *  gnome-copied-files format straight from the main process, bypassing
 *  writeResources, so the shared service has no internal state to prefer and
 *  must read the OS clipboard as source:'os'.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'
import { expectNoLeaks, evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const SOURCE_FILE = 'copy-me.md'
const EXTERNAL_FILE = 'os-external.md'

/** ITargetArg-friendly UriComponents for a local fsPath (URI paths are posix). */
function localUriComponents(fsPath: string): { scheme: 'file'; path: string } {
  return { scheme: 'file', path: fsPath.replace(/\\/g, '/') }
}

test.use({
  workspaceSeeder: {
    seed(dir) {
      fs.writeFileSync(path.join(dir, SOURCE_FILE), '# copied\n')
      fs.mkdirSync(path.join(dir, 'sub'))
    },
  },
})

async function waitForSecondWindowProbe(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
  await evaluateWhenRestored(page)
}

test.describe('@p1 shared file clipboard', () => {
  test('copy then paste duplicates the file into a subdirectory @serial', async ({
    workbench,
    page,
    launchWorkspace,
  }) => {
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
    await workbench.waitForRestored()
    const source = launchWorkspace.file(SOURCE_FILE)
    const subDir = launchWorkspace.file('sub')

    await workbench.runCommand('filesExplorer.copy', {
      resource: localUriComponents(source),
      isDirectory: false,
    })

    // The shared-service write broadcast feeds the local tree mirror + context key.
    await expect
      .poll(() => workbench.getContextKey<boolean>('fileCopied'), { timeout: 5000 })
      .toBe(true)
    const snapshot = await page.evaluate(() => window.__E2E__!.readClipboardSnapshot())
    expect(snapshot.source).toBe('internal')
    expect(snapshot.isCut).toBe(false)
    expect(snapshot.resources).toEqual([
      { resource: pathToFileURL(source).href, isDirectory: false },
    ])

    await workbench.runCommand('filesExplorer.paste', {
      resource: localUriComponents(subDir),
      isDirectory: true,
    })

    await expect
      .poll(() => fs.existsSync(path.join(subDir, SOURCE_FILE)), { timeout: 10_000 })
      .toBe(true)
    expect(fs.readFileSync(path.join(subDir, SOURCE_FILE), 'utf8')).toBe('# copied\n')
    // Copy never removes the source.
    expect(fs.existsSync(source)).toBe(true)
  })

  test('cut then paste moves the file and clears the clipboard @serial', async ({
    workbench,
    page,
    launchWorkspace,
  }) => {
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
    await workbench.waitForRestored()
    const source = launchWorkspace.file(SOURCE_FILE)
    const subDir = launchWorkspace.file('sub')

    await workbench.runCommand('filesExplorer.cut', {
      resource: localUriComponents(source),
      isDirectory: false,
    })

    await expect
      .poll(() => workbench.getContextKey<boolean>('explorerResourceCut'), { timeout: 5000 })
      .toBe(true)
    const snapshot = await page.evaluate(() => window.__E2E__!.readClipboardSnapshot())
    expect(snapshot.source).toBe('internal')
    expect(snapshot.isCut).toBe(true)

    await workbench.runCommand('filesExplorer.paste', {
      resource: localUriComponents(subDir),
      isDirectory: true,
    })

    // Paste moves (internal × cut), then clears — the broadcast empties the
    // tree mirror and both context keys.
    await expect
      .poll(() => workbench.getContextKey<boolean>('explorerResourceCut'), { timeout: 10_000 })
      .toBe(false)
    expect(await workbench.getContextKey<boolean>('fileCopied')).toBe(false)
    await expect
      .poll(() => fs.existsSync(path.join(subDir, SOURCE_FILE)), { timeout: 10_000 })
      .toBe(true)
    expect(fs.existsSync(source)).toBe(false)
  })

  test('paste in a second window uses the snapshot copied in the first @serial', async ({
    electronApp,
    workbench,
    launchWorkspace,
    scratchDir,
  }) => {
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
    await workbench.waitForRestored()
    const source = launchWorkspace.file(SOURCE_FILE)

    await workbench.runCommand('filesExplorer.copy', {
      resource: localUriComponents(source),
      isDirectory: false,
    })
    await expect
      .poll(() => workbench.getContextKey<boolean>('fileCopied'), { timeout: 5000 })
      .toBe(true)

    // A second window with its own workspace, in the SAME main process — the
    // shared clipboard must cross the window boundary.
    const secondDir = scratchDir('ue2-fc-second-')
    const newWindow = electronApp.waitForEvent('window')
    await workbench.openFolderInNewWindow(secondDir)
    const secondPage = await newWindow
    await waitForSecondWindowProbe(secondPage)
    await expect
      .poll(() => secondPage.evaluate(() => window.__E2E__!.getCurrentWorkspacePath()), {
        timeout: 8000,
      })
      .toBe(secondDir.replace(/\\/g, '/'))

    // The first window's copy broadcast reached the second window's explorer…
    await expect
      .poll(() => secondPage.evaluate(() => window.__E2E__!.getContextKey('fileCopied')), {
        timeout: 8000,
      })
      .toBe(true)
    // …and its probe reads the same main-process snapshot.
    const snapshot = await secondPage.evaluate(() => window.__E2E__!.readClipboardSnapshot())
    expect(snapshot).toEqual({
      resources: [{ resource: pathToFileURL(source).href, isDirectory: false }],
      isCut: false,
      source: 'internal',
    })

    // Paste with no explicit target: nothing selected / focused in the fresh
    // window, so the destination resolves to the workspace root.
    await secondPage.evaluate(() => window.__E2E__!.runCommand('filesExplorer.paste'))

    await expect
      .poll(() => fs.existsSync(path.join(secondDir, SOURCE_FILE)), { timeout: 10_000 })
      .toBe(true)
    // The source workspace is untouched.
    expect(fs.existsSync(source)).toBe(true)

    // The fixture only leak-checks the primary window; the second window is
    // fixture-unmanaged (mirrors smoke.windows.spec.ts).
    await expectNoLeaks(secondPage)
  })

  test('os clipboard files paste into the explorer as a copy even when cut @serial', async ({
    electronApp,
    workbench,
    page,
    launchWorkspace,
    scratchDir,
  }) => {
    // Linux-only: Windows CF_HDROP injection needs a PowerShell spawn (slow and
    // brittle); the Linux gnome format covers the os-source read + paste path.
    test.skip(process.platform !== 'linux', 'os clipboard injection is Linux-only (gnome format)')
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
    await workbench.waitForRestored()

    // Simulate another application's file copy: write the gnome-copied-files
    // format straight to the OS clipboard from the main process, bypassing
    // writeResources — the shared service holds no internal state, so
    // readResources must read the OS clipboard and report source:'os'.
    // Deliberately declare 'cut' to prove the paste-time safety degradation:
    // external cut must copy, never delete the external source.
    const externalDir = scratchDir('ue2-fc-os-')
    const externalFile = path.join(externalDir, EXTERNAL_FILE)
    fs.writeFileSync(externalFile, '# pasted from the os clipboard\n')
    const payload = `cut\n${pathToFileURL(externalFile).href}`
    await electronApp.evaluate(({ clipboard }, p) => {
      clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(p))
    }, payload)

    const expected = {
      resources: [{ resource: pathToFileURL(externalFile).href, isDirectory: false }],
      isCut: true,
      source: 'os',
    }
    // Poll: the injected write can land on the OS clipboard asynchronously.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.readClipboardSnapshot()), { timeout: 5000 })
      .toEqual(expected)

    await workbench.runCommand('filesExplorer.paste', {
      resource: localUriComponents(launchWorkspace.dir),
      isDirectory: true,
    })

    // Copy, not move: the workspace gains the file AND the external source
    // survives — os-originated entries are never deleted (data-loss guard).
    const pasted = launchWorkspace.file(EXTERNAL_FILE)
    await expect.poll(() => fs.existsSync(pasted), { timeout: 10_000 }).toBe(true)
    expect(fs.readFileSync(pasted, 'utf8')).toBe('# pasted from the os clipboard\n')
    expect(fs.existsSync(externalFile)).toBe(true)

    // The paste action only clears the clipboard after an internal move; an
    // os-source paste leaves the OS clipboard (and the read-back snapshot) as-is.
    const after = await page.evaluate(() => window.__E2E__!.readClipboardSnapshot())
    expect(after).toEqual(expected)
  })
})
