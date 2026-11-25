/*---------------------------------------------------------------------------------------------
 *  Direction navigation across auxiliary editor windows (P1).
 *
 *  `<leader>w h/j/k/l` walk groups, then parts, then the workbench window on that
 *  side of the screen. These specs place a real auxiliary BrowserWindow next to
 *  the main one and assert that focus follows the on-screen direction, and that a
 *  group inside the active window still wins over another window.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'
import {
  activateMainWindow,
  auxWindows,
  clearFocusRequests,
  focusRequests,
  installFocusProbe,
  markDocumentUnfocused,
  waitForAuxWindow,
} from './helpers/auxiliaryWindow.js'
import { setVimEnabled } from '../pages/vimHelpers.js'

function seedFile(name: string, content: string): string {
  const dir = mkTempDir('universe-editor-e2e-nav-')
  const path = join(dir, name)
  writeFileSync(path, content)
  return path.replace(/\\/g, '/')
}

/** Put the main window on the left and its auxiliary window on the right. */
async function placeAuxiliaryWindowOnTheRight(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows()
    const main = windows.find((win) => win.webContents.getURL() !== 'about:blank')
    const aux = windows.find((win) => win.webContents.getURL() === 'about:blank')
    if (!main || !aux) throw new Error('main or auxiliary window not found')
    for (const win of [main, aux]) {
      if (win.isMaximized()) win.unmaximize()
      if (win.isFullScreen()) win.setFullScreen(false)
    }
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.max(400, Math.floor((area.width - 100) / 2))
    const height = Math.max(400, Math.min(700, area.height - 80))
    main.setBounds({ x: area.x + 20, y: area.y + 20, width, height })
    aux.setBounds({ x: area.x + 20 + width + 40, y: area.y + 20, width, height })
  })
}

/**
 * Same as {@link placeAuxiliaryWindowOnTheRight}, but the main window keeps
 * enough width for SideBar + EditorArea + SecondarySideBar. The default halves
 * can be narrower than the workbench grid (which keeps its persisted sizes), so
 * the right-hand part would overflow the window and lose its screen position.
 */
async function placeWithWideMainWindow(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows()
    const main = windows.find((win) => win.webContents.getURL() !== 'about:blank')
    const aux = windows.find((win) => win.webContents.getURL() === 'about:blank')
    if (!main || !aux) throw new Error('main or auxiliary window not found')
    for (const win of [main, aux]) {
      if (win.isMaximized()) win.unmaximize()
      if (win.isFullScreen()) win.setFullScreen(false)
    }
    const area = screen.getPrimaryDisplay().workArea
    const mainWidth = Math.min(760, Math.max(640, Math.floor(area.width * 0.6)))
    const height = Math.max(480, Math.min(760, area.height - 60))
    const auxWidth = Math.max(320, Math.min(520, area.width - mainWidth - 50))
    main.setBounds({ x: area.x + 10, y: area.y + 10, width: mainWidth, height })
    aux.setBounds({ x: area.x + 10 + mainWidth + 30, y: area.y + 10, width: auxWidth, height })
  })
}

interface ScreenRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly visible: boolean
}

function readScreenRect(page: Page): Promise<ScreenRect> {
  return page.evaluate(() => ({
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight,
    visible: document.visibilityState === 'visible',
  }))
}

/** Poll until the renderer reports the two windows side by side with vertical overlap. */
async function expectSideBySide(page: Page, child: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const main = await readScreenRect(page)
        const aux = await readScreenRect(child)
        const onTheRight = aux.x >= main.x + main.width - 2
        const verticalOverlap = aux.y < main.y + main.height && aux.y + aux.height > main.y
        return aux.visible && onTheRight && verticalOverlap
      },
      { timeout: 15_000 },
    )
    .toBe(true)
}

async function groupIdsFor(
  page: Page,
  pick: (window: { isMain: boolean }) => boolean,
): Promise<readonly number[]> {
  const windows = await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())
  return windows.find(pick)?.groupIds ?? []
}

async function groupContains(page: Page, groupId: number, fileName: string): Promise<boolean> {
  const uris = await page.evaluate(
    (id) => window.__E2E__!.getEditorGroupEditorUris(String(id)),
    groupId,
  )
  return uris.some((uri) => uri.includes(fileName))
}

async function pressLeader(page: Page, key: string): Promise<void> {
  await page.keyboard.press('Space')
  await page.keyboard.press('w')
  await page.keyboard.press(key)
}

test.describe('@p1 auxiliary window direction navigation', () => {
  test('vim <leader>w l/h moves focus between side-by-side windows', async ({
    electronApp,
    workbench,
    page,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)

    const auxFile = seedFile('nav-aux-target.txt', 'aux target\n')
    const mainFile = seedFile('nav-main-target.txt', 'main target\n')

    await page.evaluate((p) => window.__E2E__!.openFileUri(p), auxFile)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    await expect
      .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
      .toContainEqual(expect.stringContaining('nav-aux-target.txt'))
    const token = (await auxWindows(page))[0]!.token

    await activateMainWindow(page)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), mainFile)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('nav-main-target.txt')

    await placeAuxiliaryWindowOnTheRight(electronApp)
    await expectSideBySide(page, child)

    await installFocusProbe(electronApp)
    await clearFocusRequests(electronApp)

    await page.locator('[data-testid="part-editorArea"] .monaco-editor').first().click()
    await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('normal')
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)

    await pressLeader(page, 'l')

    await expect
      .poll(async () => (await focusRequests(electronApp)).some((request) => request.auxiliary))
      .toBe(true)
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())
        const aux = snapshot.find((window) => !window.isMain)
        return aux?.active === true && aux.focusedPart === true
      })
      .toBe(true)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('nav-aux-target.txt')
    await expect
      .poll(() =>
        child.evaluate(
          () => document.activeElement?.closest('[data-testid="part-editorArea"]') !== null,
        ),
      )
      .toBe(true)

    // Back to the main window on the left.
    await clearFocusRequests(electronApp)
    await markDocumentUnfocused(page)
    await child.locator('[data-testid="part-editorArea"] .monaco-editor').first().click()
    await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('normal')
    // `editorTextFocus` is bridged by the main-window Monaco instance; in an
    // auxiliary window assert the focused element itself instead.
    await expect
      .poll(() => child.evaluate(() => document.activeElement?.closest('.monaco-editor') !== null))
      .toBe(true)

    await pressLeader(child, 'h')

    await expect
      .poll(async () => (await focusRequests(electronApp)).some((request) => !request.auxiliary))
      .toBe(true)
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())
        const main = snapshot.find((window) => window.isMain)
        return main?.active === true && main.focusedPart === true
      })
      .toBe(true)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('nav-main-target.txt')
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest('[data-testid="part-editorArea"]') !== null,
        ),
      )
      .toBe(true)

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('a group inside the active auxiliary window wins over the other window', async ({
    electronApp,
    workbench,
    page,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)

    const leftFile = seedFile('nav-aux-left.txt', 'left\n')
    const rightFile = seedFile('nav-aux-right.txt', 'right\n')
    const mainFile = seedFile('nav-main.txt', 'main\n')

    await page.evaluate((p) => window.__E2E__!.openFileUri(p), leftFile)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    const token = (await auxWindows(page))[0]!.token

    await activateMainWindow(page)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), mainFile)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('nav-main.txt')

    await placeAuxiliaryWindowOnTheRight(electronApp)
    await expectSideBySide(page, child)

    // Split inside the auxiliary window and open the second file in the new right group.
    await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.splitEditorRight')
    })
    await expect.poll(async () => (await groupIdsFor(page, (w) => !w.isMain)).length).toBe(2)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), rightFile)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('nav-aux-right.txt')

    let leftGroupId: number | undefined
    for (const id of await groupIdsFor(page, (w) => !w.isMain)) {
      if (await groupContains(page, id, 'nav-aux-left.txt')) leftGroupId = id
    }
    expect(leftGroupId).toBeDefined()

    await clearFocusRequests(electronApp)
    await child.locator(`[data-group-id="${leftGroupId}"] .monaco-editor`).first().click()
    await expect.poll(() => workbench.getContextKey<string>('vimMode')).toBe('normal')
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)

    await pressLeader(child, 'l')

    await expect.poll(() => workbench.getActiveEditorUri()).toContain('nav-aux-right.txt')
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())
        const aux = snapshot.find((window) => !window.isMain)
        return aux?.active === true && aux.focusedPart === true
      })
      .toBe(true)
    expect((await focusRequests(electronApp)).some((request) => !request.auxiliary)).toBe(false)

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('entering the main window from the right lands on its right-hand view', async ({
    electronApp,
    workbench,
    page,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)

    const auxFile = seedFile('nav-aux-outline.txt', 'aux outline target\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), auxFile)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    const token = (await auxWindows(page))[0]!.token

    await placeWithWideMainWindow(electronApp)
    await expectSideBySide(page, child)

    // Reveal and focus the Outline in the main window's right-hand secondary
    // side bar. That also records the view as the part's last-focused view, so
    // focusPart can restore it later.
    await activateMainWindow(page)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })
    await expect
      .poll(() => workbench.getContextKey<string>('focusedView'))
      .toBe('workbench.view.outline.main')
    await expect.poll(() => workbench.getContextKey<boolean>('secondarySideBarVisible')).toBe(true)

    await installFocusProbe(electronApp)
    await clearFocusRequests(electronApp)

    // Hand activation to the auxiliary window without moving DOM focus, then
    // navigate left from it. `<leader>w h` is the same action (covered from an
    // auxiliary editor by the first spec); driving the command here keeps this
    // spec independent from the background document's Vim surface timing.
    await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)
    // Playwright emulates focus for every driven page; the main-window guard
    // still reads document.hasFocus().
    await markDocumentUnfocused(page)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.navigateLeft')
    })

    await expect
      .poll(async () => (await focusRequests(electronApp)).some((request) => !request.auxiliary))
      .toBe(true)
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())
        return snapshot.find((window) => window.isMain)?.active === true
      })
      .toBe(true)
    // The auxiliary window is whole-editor; entering the main window must pick
    // its right-hand part (Outline) instead of the editor area.
    await expect
      .poll(() => workbench.getContextKey<string>('focusedView'))
      .toBe('workbench.view.outline.main')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.activeElement?.closest('[data-view-id="workbench.view.outline.main"]') !==
            null,
        ),
      )
      .toBe(true)

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })
})
