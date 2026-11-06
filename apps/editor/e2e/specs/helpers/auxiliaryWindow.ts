/*---------------------------------------------------------------------------------------------
 *  Shared helpers for auxiliary-window specs: opening a popup through a command,
 *  reading the window registry snapshot, and recording native focus requests.
 *  Kept out of the spec files so a second aux-window suite can reuse them without
 *  importing a file that registers Playwright tests.
 *--------------------------------------------------------------------------------------------*/

import { expect, type ElectronApplication, type Page } from '@playwright/test'

/** Run `command` and wait for the popup it opens; resolves once its workbench mounted. */
export async function waitForAuxWindow(
  electronApp: ElectronApplication,
  workbench: { runCommand(id: string, ...args: unknown[]): Promise<unknown> },
  command: string,
  arg?: unknown,
): Promise<Page> {
  const pagePromise = electronApp.waitForEvent('window')
  await workbench.runCommand(command, ...(arg === undefined ? [] : [arg]))
  const child = (await pagePromise) as Page
  await child.waitForLoadState('domcontentloaded')
  // The React portal mounts on the next render after the window registry event.
  await expect(child.locator('[data-testid="part-editorArea"]')).toBeVisible()
  return child
}

export async function auxWindows(page: Page) {
  return page.evaluate(() => window.__E2E__!.getAuxiliaryWindows())
}

export interface FocusRequest {
  readonly id: number
  readonly auxiliary: boolean
  readonly method: 'focus' | 'showInactive'
}

/**
 * Record every native window-focus request made after installation. Auxiliary
 * windows are `about:blank` popups, so the URL identifies the target without
 * coupling the spec to window ids or creation order. Silent E2E routes focus
 * through `showInactive`, but both methods are recorded so the probe also works
 * when `UNIVERSE_E2E_SHOW=1` restores real focusing.
 */
export async function installFocusProbe(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const holder = globalThis as unknown as { __ueFocusRequests?: unknown[] }
    holder.__ueFocusRequests = []
    type WinLike = { id: number; webContents: { getURL(): string } }
    const prototype = BrowserWindow.prototype as unknown as {
      focus(this: WinLike): void
      showInactive(this: WinLike): void
    }
    const originalFocus = prototype.focus
    const originalShowInactive = prototype.showInactive
    const record = (win: WinLike, method: 'focus' | 'showInactive'): void => {
      holder.__ueFocusRequests!.push({
        id: win.id,
        auxiliary: win.webContents.getURL() === 'about:blank',
        method,
      })
    }
    prototype.focus = function (this: WinLike) {
      record(this, 'focus')
      return originalFocus.call(this)
    }
    prototype.showInactive = function (this: WinLike) {
      record(this, 'showInactive')
      return originalShowInactive.call(this)
    }
  })
}

export async function clearFocusRequests(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    const holder = globalThis as unknown as { __ueFocusRequests?: unknown[] }
    holder.__ueFocusRequests = []
  })
}

export async function focusRequests(electronApp: ElectronApplication): Promise<FocusRequest[]> {
  return electronApp.evaluate(() => {
    const holder = globalThis as unknown as { __ueFocusRequests?: unknown[] }
    return (holder.__ueFocusRequests ?? []) as never
  })
}

/**
 * Playwright enables focus emulation, so `document.hasFocus()` reports true for
 * every page it drives — including a background auxiliary window. The focus
 * service deliberately skips the native request when the target document is
 * already focused, so make the auxiliary document look unfocused like a real
 * background window before asserting that a request happens.
 */
export async function markDocumentUnfocused(window: Page): Promise<void> {
  await window.evaluate(() => {
    Document.prototype.hasFocus = () => false
  })
}

/** Clicking the main editor area routes activation back to the main part without OS focus. */
export async function activateMainWindow(page: Page): Promise<void> {
  await page.locator('[data-testid="part-editorArea"]').click({ position: { x: 4, y: 4 } })
}
