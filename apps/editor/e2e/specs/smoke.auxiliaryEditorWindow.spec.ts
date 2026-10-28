/*---------------------------------------------------------------------------------------------
 *  Auxiliary editor windows (P0).
 *
 *  Real-app coverage for the multi-window editor path: window creation, moving
 *  editors/groups, shared Monaco models, close semantics, restore-to-main,
 *  workspace persistence and document ownership (keyboard, quick input, menus,
 *  mirrored theme). Auxiliary windows are same-renderer same-origin popups, so
 *  Playwright sees them as additional Pages while the probe stays on the main
 *  window.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkTempDir, QuickInputPO } from '@universe-editor/e2e-harness'

const ECHO_AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'test-fixtures',
  'echoAgent.cjs',
)

/** Install the echo agent and open one session editor. */
async function openEchoSession(page: Page, env: Record<string, string> = {}): Promise<void> {
  await page.evaluate(([id, p, extra]) => window.__E2E__!.installAcpEchoAgent(id, p, extra), [
    'echo',
    ECHO_AGENT_PATH,
    env,
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10_000 })
    .toBe(1)
}

function seedFile(name: string, content: string): string {
  const dir = mkTempDir('universe-editor-e2e-aux-')
  const path = join(dir, name)
  writeFileSync(path, content)
  return path.replace(/\\/g, '/')
}

async function waitForAuxWindow(
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

async function auxWindows(page: Page) {
  return page.evaluate(() => window.__E2E__!.getAuxiliaryWindows())
}

interface FocusRequest {
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
async function installFocusProbe(electronApp: ElectronApplication): Promise<void> {
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

async function clearFocusRequests(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    const holder = globalThis as unknown as { __ueFocusRequests?: unknown[] }
    holder.__ueFocusRequests = []
  })
}

async function focusRequests(electronApp: ElectronApplication): Promise<FocusRequest[]> {
  return electronApp.evaluate(() => {
    const holder = globalThis as unknown as { __ueFocusRequests?: unknown[] }
    return (holder.__ueFocusRequests ?? []) as never
  })
}

interface FlashRequest {
  readonly id: number
  readonly auxiliary: boolean
  readonly flag: boolean
}

/** Record taskbar attention requests per native window (same realm test as the focus probe). */
async function installFlashProbe(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const holder = globalThis as unknown as { __ueFlashRequests?: unknown[] }
    holder.__ueFlashRequests = []
    type WinLike = { id: number; webContents: { getURL(): string } }
    const prototype = BrowserWindow.prototype as unknown as {
      flashFrame(this: WinLike, flag: boolean): void
    }
    const original = prototype.flashFrame
    prototype.flashFrame = function (this: WinLike, flag: boolean) {
      holder.__ueFlashRequests!.push({
        id: this.id,
        auxiliary: this.webContents.getURL() === 'about:blank',
        flag,
      })
      return original.call(this, flag)
    }
  })
}

async function clearFlashRequests(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    const holder = globalThis as unknown as { __ueFlashRequests?: unknown[] }
    holder.__ueFlashRequests = []
  })
}

async function flashRequests(electronApp: ElectronApplication): Promise<FlashRequest[]> {
  return electronApp.evaluate(() => {
    const holder = globalThis as unknown as { __ueFlashRequests?: unknown[] }
    return (holder.__ueFlashRequests ?? []) as never
  })
}

/** Whether any auxiliary group holds an ACP session tab. */
async function auxiliaryHasSessionTab(page: Page): Promise<boolean> {
  return (await auxWindows(page))[0]?.groups
    .flatMap((group) => group.editorUris)
    .some((uri) => uri.includes('/acp/session/'))
    ? true
    : false
}

/** Clicking the main editor area routes activation back to the main part without OS focus. */
async function activateMainWindow(page: Page): Promise<void> {
  await page.locator('[data-testid="part-editorArea"]').click({ position: { x: 4, y: 4 } })
}

/** Asserts a native focus request went to the auxiliary window and DOM focus followed. */
async function expectAuxiliaryFocus(
  electronApp: ElectronApplication,
  child: Page,
  workbench: { getActiveEditorUri(): Promise<string | undefined> },
  fileName: string,
): Promise<void> {
  await expect
    .poll(async () => (await focusRequests(electronApp)).some((request) => request.auxiliary))
    .toBe(true)
  await expect.poll(() => workbench.getActiveEditorUri()).toContain(fileName)
  await expect
    .poll(() =>
      child.evaluate(
        () => document.activeElement?.closest('[data-testid="part-editorArea"]') !== null,
      ),
    )
    .toBe(true)
}

/**
 * Playwright enables focus emulation, so `document.hasFocus()` reports true for
 * every page it drives — including a background auxiliary window. The focus
 * service deliberately skips the native request when the target document is
 * already focused, so make the auxiliary document look unfocused like a real
 * background window before asserting that a request happens.
 */
async function markDocumentUnfocused(window: Page): Promise<void> {
  await window.evaluate(() => {
    Document.prototype.hasFocus = () => false
  })
}

/**
 * Synthetic HTML5 drag events, dispatched into the live React tree.
 *
 * Playwright/CDP cannot perform a native OS drag from one Electron BrowserWindow
 * to another, so the gesture is synthesized. Everything downstream is real: the
 * handlers, the shared DragSession context, window screen geometry, the IPC
 * round-trip and the editor migration. This is deliberately NOT a probe shortcut
 * that calls moveEditorToNewWindow directly.
 */
async function startTabDrag(page: Page, tabIndex = 0): Promise<void> {
  await page.evaluate((index) => {
    const tab = document.querySelectorAll<HTMLElement>(
      '[data-testid="editor-group-tabbar"] [role="tab"]',
    )[index]
    if (!tab) throw new Error('tab not found')
    const rect = tab.getBoundingClientRect()
    tab.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    )
  }, tabIndex)
}

async function endTabDrag(page: Page, screenX: number, screenY: number): Promise<void> {
  await page.evaluate(
    ({ x, y }) => {
      const tab = document.querySelector<HTMLElement>(
        '[data-testid="editor-group-tabbar"] [role="tab"]',
      )
      tab?.dispatchEvent(
        new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          screenX: x,
          screenY: y,
        }),
      )
    },
    { x: screenX, y: screenY },
  )
}

async function dropOnGroupBody(
  target: Page,
  position: 'center' | 'left',
  options: { ctrl?: boolean } = {},
): Promise<void> {
  await target.evaluate(
    ({ position, ctrlKey }) => {
      const body = document.querySelector<HTMLElement>('[data-testid="editor-group-body"]')
      if (!body) throw new Error('editor group body not found')
      const rect = body.getBoundingClientRect()
      const clientX =
        position === 'left' ? rect.left + rect.width * 0.05 : rect.left + rect.width / 2
      const init: DragEventInit = {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: rect.top + rect.height / 2,
        ctrlKey,
        dataTransfer: new DataTransfer(),
      }
      body.dispatchEvent(new DragEvent('dragover', init))
      body.dispatchEvent(new DragEvent('drop', init))
    },
    { position, ctrlKey: options.ctrl === true },
  )
}

test.describe('@p0 auxiliary editor windows', () => {
  test('new empty window is a real workbench window without IPC', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.newEmptyEditorWindow',
    )

    await expect.poll(async () => (await auxWindows(page)).length, { timeout: 15_000 }).toBe(1)
    const [entry] = await auxWindows(page)
    expect(entry).toBeDefined()
    expect(entry!.explicitEmpty).toBe(true)
    expect(entry!.hasAuxiliaryMarker).toBe(true)
    expect(entry!.hasIpc).toBe(false)
    expect(entry!.hasRoot).toBe(true)
    expect(entry!.styleCount).toBeGreaterThan(0)
    expect(entry!.baseHref).toContain('universe-app://')
    // The theme service applies after the restored phase; the window chrome
    // observer mirrors it asynchronously.
    await expect.poll(async () => (await auxWindows(page))[0]?.theme).toBeTruthy()

    expect(await child.evaluate(() => typeof (window as never as { ipc?: unknown }).ipc)).toBe(
      'undefined',
    )
    const windows = await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())
    expect(windows).toHaveLength(2)
    expect(windows.filter((w) => !w.isMain)).toHaveLength(1)

    await page.evaluate((token) => window.__E2E__!.requestCloseAuxiliaryWindow(token), entry!.token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('move editor to new window and restore all back to main', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    const file = seedFile('move-me.txt', 'hello auxiliary\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const mainGroup = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows()))[0]!
      .groupIds[0]!

    await waitForAuxWindow(electronApp, workbench, 'workbench.action.moveEditorToNewWindow')
    await expect
      .poll(async () => {
        const [entry] = await auxWindows(page)
        return entry?.groups.flatMap((g) => g.editorUris) ?? []
      })
      .toContainEqual(expect.stringContaining('move-me.txt'))
    expect(
      await page.evaluate((id) => window.__E2E__!.getEditorGroupEditorUris(id), String(mainGroup)),
    ).toEqual([])

    // Product semantics: every auxiliary group folds into the main part's
    // active group (not VSCode's per-part mergeAllGroups).
    const token = (await auxWindows(page))[0]!.token
    await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)
    const second = seedFile('move-me-second.txt', 'second\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), second)
    await expect
      .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
      .toContainEqual(expect.stringContaining('move-me-second.txt'))
    await workbench.runCommand('workbench.action.splitEditorRight')
    await expect.poll(async () => (await auxWindows(page))[0]?.groups.length ?? 0).toBe(2)

    await page.evaluate(() =>
      window.__E2E__!.runCommand('workbench.action.restoreEditorsToMainWindow'),
    )
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    const restored = await page.evaluate(
      (id) => window.__E2E__!.getEditorGroupEditorUris(id),
      String(mainGroup),
    )
    expect(restored).toContainEqual(expect.stringContaining('move-me.txt'))
    expect(restored).toContainEqual(expect.stringContaining('move-me-second.txt'))
  })

  test('copy editor keeps one shared Monaco model and both copies go dirty', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    const file = seedFile('shared-model.txt', 'shared\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.copyEditorToNewWindow',
    )
    await expect
      .poll(async () => (await auxWindows(page))[0]?.groups[0]?.editorUris.length ?? 0)
      .toBe(1)

    // Type in the auxiliary copy: the main tab's input must observe the same
    // model (dirty + live text), because copies share the Monaco model.
    await child.locator('.monaco-editor').first().click()
    await child.keyboard.type('typed-in-aux')
    await expect
      .poll(async () => {
        const entry = (await auxWindows(page))[0]
        return entry?.groups[0]?.activeEditorDirty ?? false
      })
      .toBe(true)
    const uri = (await auxWindows(page))[0]!.groups[0]!.editorUris[0]!
    expect(await page.evaluate((u) => window.__E2E__!.isEditorUriDirty(u), uri)).toBe(true)

    await page.evaluate(() =>
      window.__E2E__!.runCommand('workbench.action.restoreEditorsToMainWindow'),
    )
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('dirty editor migrates back to the main window when the window closes', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    const file = seedFile('dirty-close.txt', 'dirty\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await workbench.editor.monacoEditor.click()
    await page.keyboard.type('dirty!')
    await expect.poll(() => page.evaluate(() => window.__E2E__!.isActiveEditorDirty())).toBe(true)

    await waitForAuxWindow(electronApp, workbench, 'workbench.action.moveEditorToNewWindow')
    await expect
      .poll(async () => (await auxWindows(page))[0]?.groups[0]?.activeEditorDirty ?? false)
      .toBe(true)
    const token = (await auxWindows(page))[0]!.token

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    const main = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
      (w) => w.isMain,
    )!
    expect(
      await page.evaluate(
        (id) => window.__E2E__!.getEditorGroupEditorUris(id),
        String(main.groupIds[0]!),
      ),
    ).toContainEqual(expect.stringContaining('dirty-close.txt'))
  })

  test('keyboard and quick input belong to the focused auxiliary document', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    // The bootstrap focus restore lands after waitForRestored and would steal
    // activation back to the main window mid-test.
    await workbench.waitForBootstrapFocusSettled()
    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.newEmptyEditorWindow',
    )
    const token = (await auxWindows(page))[0]!.token
    // Activation must be the last thing before the key press: anything that
    // focuses the main document in between makes quick input open there.
    await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)

    await child.keyboard.press('Control+Shift+P')
    await expect(child.locator('[data-testid="quick-input-overlay"]')).toBeVisible()
    // The panel was portalled into the auxiliary body, not the main one.
    await expect(page.locator('[data-testid="quick-input-overlay"]')).toHaveCount(0)
    await child.keyboard.press('Escape')
    await expect(child.locator('[data-testid="quick-input-overlay"]')).toHaveCount(0)

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('theme and tab context menu are owned by the auxiliary document', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    const file = seedFile('context-menu.txt', 'menu\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['theme']))
      .toBeTruthy()
    const mainTheme = await page.evaluate(() => document.documentElement.dataset['theme'])
    await expect
      .poll(() => child.evaluate(() => document.documentElement.dataset['theme']))
      .toBe(mainTheme)

    await child.getByRole('tab').first().click({ button: 'right' })
    const menu = child.locator('[role="menu"]').first()
    await expect(menu).toBeVisible()
    await expect(menu).toContainText(/Close|关闭/)
    await expect(page.locator('[role="menu"]')).toHaveCount(0)
    await child.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    const token = (await auxWindows(page))[0]!.token
    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('editor text and title menus are owned by the auxiliary document', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    const file = seedFile('aux-menus.txt', 'menu target\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    const token = (await auxWindows(page))[0]!.token

    // Real pointer gesture inside the Monaco text area: the MenuRegistry-driven
    // editor/context menu must portal into the auxiliary body. This is the path
    // that used to fall back to the main document.
    const monaco = child.locator('.monaco-editor').first()
    await monaco.click()
    await monaco.click({ button: 'right', position: { x: 40, y: 40 } })
    const textMenu = child.locator('[role="menu"]').first()
    await expect(textMenu).toBeVisible()
    await expect(textMenu).toContainText(/Show All Commands|显示所有命令/)
    await expect(page.locator('[role="menu"]')).toHaveCount(0)
    await child.keyboard.press('Escape')
    await expect(textMenu).toHaveCount(0)

    // The title overflow menu is rendered by EditorTitleActions and needs the
    // same document ownership.
    const overflow = child.locator('[data-testid="editor-title-overflow"]')
    await expect(overflow).toBeVisible()
    await overflow.click()
    const titleMenu = child.locator('[role="menu"]').first()
    await expect(titleMenu).toBeVisible()
    await expect(page.locator('[role="menu"]')).toHaveCount(0)
    await child.keyboard.press('Escape')
    await expect(titleMenu).toHaveCount(0)

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('main non-editor chrome keeps opens in the auxiliary window; the main editor area takes them back', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    const moved = seedFile('focus-main-moved.txt', 'moved\n')
    const stay = seedFile('focus-main-stay.txt', 'stay\n')
    const next = seedFile('focus-main-next.txt', 'next\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), moved)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    const token = (await auxWindows(page))[0]!.token
    await child.locator('.monaco-editor').first().click()
    await expect.poll(async () => (await auxWindows(page))[0]?.active ?? false).toBe(true)
    const mainGroupId = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
      (w) => w.isMain,
    )!.groupIds[0]!
    const mainUris = () =>
      page.evaluate((id) => window.__E2E__!.getEditorGroupEditorUris(String(id)), mainGroupId)
    const auxUris = async () =>
      (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? []

    // Main chrome (activity bar) activates the main *window* only: the editor
    // open target stays on the last-used auxiliary part (VSCode parity).
    await page.locator('[data-testid="part-activitybar"]').click({ position: { x: 4, y: 4 } })
    await expect
      .poll(() =>
        page.evaluate(() => window.__E2E__!.getWorkbenchWindows().find((w) => w.isMain)?.active),
      )
      .toBe(true)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), stay)
    await expect.poll(auxUris).toContainEqual(expect.stringContaining('focus-main-stay.txt'))
    expect(await mainUris()).not.toContainEqual(expect.stringContaining('focus-main-stay.txt'))

    // Interaction inside the main editor area makes main the target again.
    await activateMainWindow(page)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), next)
    await expect.poll(mainUris).toContainEqual(expect.stringContaining('focus-main-next.txt'))
    expect(await auxUris()).not.toContainEqual(expect.stringContaining('focus-main-next.txt'))

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test.describe('explorer opens follow the last-used auxiliary window', () => {
    test.use({
      workspaceSeeder: {
        seed(dir) {
          for (const name of ['aux-ex-a.txt', 'aux-ex-b.txt', 'aux-ex-c.txt', 'aux-ex-d.txt']) {
            writeFileSync(join(dir, name), `${name}\n`)
          }
        },
      },
    })

    test('Ctrl+Shift+E then Enter / Ctrl+Enter open in the auxiliary window', async ({
      electronApp,
      workbench,
      page,
      launchWorkspace,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      await page.evaluate(
        (p) => window.__E2E__!.openFileUri(p),
        launchWorkspace!.file('aux-ex-a.txt'),
      )
      await expect(workbench.editor.monacoEditor).toBeVisible()
      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.moveEditorToNewWindow',
      )
      const token = (await auxWindows(page))[0]!.token
      await child.locator('.monaco-editor').first().click()
      await expect.poll(async () => (await auxWindows(page))[0]?.active ?? false).toBe(true)
      await markDocumentUnfocused(child)
      await installFocusProbe(electronApp)
      await clearFocusRequests(electronApp)
      const auxGroups = async () => (await auxWindows(page))[0]?.groups ?? []
      const mainUris = async () => {
        const main = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
          (w) => w.isMain,
        )!
        const lists = await Promise.all(
          main.groupIds.map((id) =>
            page.evaluate((g) => window.__E2E__!.getEditorGroupEditorUris(String(g)), id),
          ),
        )
        return lists.flat()
      }
      const row = (name: string) => page.locator('[role="treeitem"]', { hasText: name })
      const tree = page
        .locator('[role="tree"]')
        .filter({ has: row('aux-ex-a.txt') })
        .first()
      // focusView settles over frames; keys sent before the tree owns focus are lost.
      const expectTreeFocused = () => expect(tree).toHaveAttribute('data-focused', 'true')

      // Single-click preview keeps focus in Explorer and must not pull the
      // auxiliary window forward, but still lands there.
      await child.keyboard.press('Control+Shift+E')
      await expect
        .poll(() =>
          page.evaluate(() => window.__E2E__!.getWorkbenchWindows().find((w) => w.isMain)?.active),
        )
        .toBe(true)
      await expectTreeFocused()
      await row('aux-ex-b.txt').click()
      await expect
        .poll(async () => (await auxGroups()).flatMap((g) => g.editorUris))
        .toContainEqual(expect.stringContaining('aux-ex-b.txt'))
      expect((await focusRequests(electronApp)).some((r) => r.auxiliary)).toBe(false)
      await tree.focus()
      await expectTreeFocused()

      // Enter on a not-yet-open file: lands in the auxiliary group and brings
      // that window forward.
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await expectAuxiliaryFocus(electronApp, child, workbench, 'aux-ex-c.txt')
      expect((await auxGroups()).flatMap((g) => g.editorUris)).toContainEqual(
        expect.stringContaining('aux-ex-c.txt'),
      )

      // Ctrl+Enter splits inside the auxiliary window, not the main one.
      await clearFocusRequests(electronApp)
      await child.keyboard.press('Control+Shift+E')
      await expect
        .poll(() =>
          page.evaluate(() => window.__E2E__!.getWorkbenchWindows().find((w) => w.isMain)?.active),
        )
        .toBe(true)
      await expectTreeFocused()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Control+Enter')
      await expect.poll(async () => (await auxGroups()).length).toBe(2)
      await expect
        .poll(async () => (await auxGroups())[1]?.editorUris ?? [])
        .toContainEqual(expect.stringContaining('aux-ex-d.txt'))
      await expectAuxiliaryFocus(electronApp, child, workbench, 'aux-ex-d.txt')

      expect(await mainUris()).not.toContainEqual(expect.stringMatching(/aux-ex-[bcd]\.txt/))

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })
  })

  test.describe('focused window vs open target', () => {
    test.use({
      workspaceSeeder: {
        seed(dir) {
          for (const name of ['focus-a.txt', 'focus-b.txt', 'focus-c.txt']) {
            writeFileSync(join(dir, name), `${name}\n`)
          }
        },
      },
    })

    test('Ctrl+W closes the focused window editor after Alt+Tab, while opens still land in the auxiliary window @regression', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()

      const mainUris = async () => {
        const main = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
          (w) => w.isMain,
        )!
        const lists = await Promise.all(
          main.groupIds.map((id) =>
            page.evaluate((g) => window.__E2E__!.getEditorGroupEditorUris(String(g)), id),
          ),
        )
        return lists.flat()
      }
      const auxUris = async () =>
        (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? []
      const windows = () => page.evaluate(() => window.__E2E__!.getWorkbenchWindows())

      // 主窗口打开 a（单击 Explorer 行先在主窗口落一个预览标签）。
      await workbench.showExplorer()
      const rowA = page.locator('[role="treeitem"]', { hasText: 'focus-a.txt' })
      await expect(rowA).toBeVisible({ timeout: 10_000 })
      await rowA.click()
      const tree = page.locator('[role="tree"]').filter({ has: rowA }).first()
      await tree.focus()
      await expect(tree).toHaveAttribute('data-focused', 'true')
      await expect.poll(mainUris).toContainEqual(expect.stringContaining('focus-a.txt'))

      // 选中 b，Alt+Enter 把它开进辅助窗口。
      await page.keyboard.press('ArrowDown')
      await expect(
        page.locator('[role="treeitem"][aria-selected="true"]', { hasText: 'focus-b.txt' }),
      ).toBeVisible()
      const pagePromise = electronApp.waitForEvent('window')
      await page.keyboard.press('Alt+Enter')
      const child = (await pagePromise) as Page
      await child.waitForLoadState('domcontentloaded')
      await expect(child.locator('[data-testid="part-editorArea"]')).toBeVisible()
      const token = (await auxWindows(page))[0]!.token

      await expect.poll(auxUris).toContainEqual(expect.stringContaining('focus-b.txt'))
      expect(await mainUris()).toContainEqual(expect.stringContaining('focus-a.txt'))
      expect(await mainUris()).not.toContainEqual(expect.stringContaining('focus-b.txt'))
      await expect.poll(async () => (await windows()).find((w) => !w.isMain)?.active).toBe(true)

      // Alt+Tab 回主窗口：焦点切到主 part，打开落点仍是辅助窗口。
      await page.evaluate(() => window.__E2E__!.focusMainWindow())
      await expect.poll(async () => (await windows()).find((w) => w.isMain)?.focusedPart).toBe(true)
      await expect
        .poll(async () => (await windows()).find((w) => !w.isMain)?.openTargetPart)
        .toBe(true)
      expect((await windows()).find((w) => !w.isMain)?.focusedPart).toBe(false)

      // Ctrl+W 必须关闭聚焦窗口的 a，而不是打开落点窗口的 b。
      await page.keyboard.press('Control+w')
      await expect.poll(mainUris).not.toContainEqual(expect.stringContaining('focus-a.txt'))
      await expect.poll(auxUris).toContainEqual(expect.stringContaining('focus-b.txt'))

      // Ctrl+W 同样不得改动打开落点：Explorer Enter 仍落辅助窗口并前置它。
      await workbench.showExplorer()
      await tree.focus()
      await expect(tree).toHaveAttribute('data-focused', 'true')
      await page.keyboard.press('End')
      await expect(
        page.locator('[role="treeitem"][aria-selected="true"]', { hasText: 'focus-c.txt' }),
      ).toBeVisible()
      await page.keyboard.press('Enter')
      await expect.poll(auxUris).toContainEqual(expect.stringContaining('focus-c.txt'))
      expect(await mainUris()).not.toContainEqual(expect.stringContaining('focus-c.txt'))
      await expect.poll(async () => (await windows()).find((w) => !w.isMain)?.active).toBe(true)

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })
  })

  test('moving and copying an editor group targets the active group', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    const file = seedFile('group-move.txt', 'group\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    const mainGroup = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows()))[0]!
      .groupIds[0]!

    await waitForAuxWindow(electronApp, workbench, 'workbench.action.moveEditorGroupToNewWindow')
    await expect
      .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
      .toContainEqual(expect.stringContaining('group-move.txt'))
    expect(
      await page.evaluate((id) => window.__E2E__!.getEditorGroupEditorUris(id), String(mainGroup)),
    ).toEqual([])

    await page.evaluate(() =>
      window.__E2E__!.runCommand('workbench.action.restoreEditorsToMainWindow'),
    )
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    expect(
      await page.evaluate((id) => window.__E2E__!.getEditorGroupEditorUris(id), String(mainGroup)),
    ).toContainEqual(expect.stringContaining('group-move.txt'))

    // Copy keeps the source editor in place and adds an independent copy.
    await waitForAuxWindow(electronApp, workbench, 'workbench.action.copyEditorGroupToNewWindow')
    await expect
      .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
      .toContainEqual(expect.stringContaining('group-move.txt'))
    expect(
      await page.evaluate((id) => window.__E2E__!.getEditorGroupEditorUris(id), String(mainGroup)),
    ).toContainEqual(expect.stringContaining('group-move.txt'))

    const token = (await auxWindows(page))[0]!.token
    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('find and suggest overlays render in the auxiliary document', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    const file = seedFile('overlays.txt', 'alpha beta alpha gamma\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    await child.locator('.monaco-editor').first().click()

    await page.evaluate(() => window.__E2E__!.runCommand('editor.action.triggerSuggest'))
    await expect(child.locator('.suggest-widget')).toBeVisible()
    await expect(page.locator('.suggest-widget')).toHaveCount(0)
    await child.keyboard.press('Escape')

    await child.keyboard.press('Control+f')
    await expect(child.locator('.find-widget')).toBeVisible()
    await expect(page.locator('.find-widget')).toHaveCount(0)

    const token = (await auxWindows(page))[0]!.token
    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('renderer dialog opens in the focused auxiliary document', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.newEmptyEditorWindow',
    )
    const token = (await auxWindows(page))[0]!.token
    await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)

    // Fire-and-forget: the command's promise resolves only after the dialog is
    // answered, so awaiting it here would deadlock the test.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.startHeapSnapshotDiagnostics')
    })

    const dialog = child.locator('[data-renderer-dialog]')
    await expect(dialog).toBeVisible()
    // The document is captured when the operation starts, not when the dialog
    // service was constructed — the main window must stay untouched.
    await expect(page.locator('[data-renderer-dialog]')).toHaveCount(0)

    await child.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('tab bar background menu targets the clicked group, not the active one', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() !== 'about:blank',
      )!
      main.setBounds({ ...main.getBounds(), width: 1024, height: 768 })
    })
    const first = seedFile('menu-group-a.txt', 'A\n')
    const second = seedFile('menu-group-b.txt', 'B\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), first)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await workbench.runCommand('workbench.action.splitEditorRight')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), second)
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)

    const mainWindow = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
      (w) => w.isMain,
    )!
    const groupIds = mainWindow.groupIds
    const urisByGroup = new Map<number, readonly string[]>()
    for (const id of groupIds) {
      urisByGroup.set(
        id,
        await page.evaluate((g) => window.__E2E__!.getEditorGroupEditorUris(String(g)), id),
      )
    }
    const clickedGroup = [...urisByGroup].find(([, uris]) =>
      uris.some((u) => u.includes('menu-group-a.txt')),
    )![0]
    const otherGroup = groupIds.find((id) => id !== clickedGroup)!

    // The other group is the one active after the split, so this menu must act
    // on the clicked (inactive) group.
    const tabBar = page.locator(
      `[data-group-id="${clickedGroup}"] [data-testid="editor-group-tabbar"]`,
    )
    const position = await tabBar.evaluate((bar) => {
      const rect = bar.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      for (let x = rect.right - 4; x > rect.left; x -= 4) {
        if (bar.ownerDocument.elementFromPoint(x, y) === bar) {
          return { x: x - rect.left, y: y - rect.top }
        }
      }
      throw new Error(`No tab bar background within ${rect.width}px`)
    })
    await tabBar.click({ button: 'right', position })
    const menu = page.locator('[role="menu"]').first()
    await expect(menu).toBeVisible()
    await expect(menu).toContainText(/Move Group into New Window/)
    await expect(menu).toContainText(/Copy Group into New Window/)

    const windowPromise = electronApp.waitForEvent('window')
    await menu.getByText(/Move Group into New Window/).click()
    const child = (await windowPromise) as Page
    await child.waitForLoadState('domcontentloaded')
    await expect(child.locator('[data-testid="part-editorArea"]')).toBeVisible()

    await expect
      .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
      .toContainEqual(expect.stringContaining('menu-group-a.txt'))
    expect(
      await page.evaluate(
        (id) => window.__E2E__!.getEditorGroupEditorUris(String(id)),
        clickedGroup,
      ),
    ).toEqual([])
    expect(
      await page.evaluate((id) => window.__E2E__!.getEditorGroupEditorUris(String(id)), otherGroup),
    ).toContainEqual(expect.stringContaining('menu-group-b.txt'))

    const token = (await auxWindows(page))[0]!.token
    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('window close and zoom commands act on the focused auxiliary window', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await waitForAuxWindow(electronApp, workbench, 'workbench.action.newEmptyEditorWindow')
    const token = (await auxWindows(page))[0]!.token
    await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)

    const zoomFactors = async () =>
      electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => ({
          // Auxiliary windows are `about:blank` popups; they are not child
          // BrowserWindows (`getParentWindow()` stays null).
          auxiliary: w.webContents.getURL() === 'about:blank',
          factor: w.webContents.getZoomFactor(),
        })),
      )

    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.zoomIn'))
    await expect
      .poll(async () => (await zoomFactors()).find((w) => w.auxiliary)?.factor ?? 1)
      .toBeGreaterThan(1)
    // The main workspace zoom must not change.
    expect((await zoomFactors()).find((w) => !w.auxiliary)?.factor ?? 1).toBeCloseTo(1, 3)

    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.zoomReset'))
    await expect
      .poll(async () => (await zoomFactors()).find((w) => w.auxiliary)?.factor ?? 1)
      .toBeCloseTo(1, 3)

    // Ctrl+Shift+W in an auxiliary window must close that window, not the
    // main workspace that is still running behind it.
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.closeWindow'))
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    expect(await page.evaluate(() => window.__E2E__!.getWorkbenchWindows().length)).toBe(1)
  })

  test.describe('cross-window focus follows activation', () => {
    test('Ctrl+P selecting a file already open in an auxiliary window focuses it', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      const file = seedFile('quick-open-aux.txt', 'aux target\n')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
      await expect(workbench.editor.monacoEditor).toBeVisible()

      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.moveEditorToNewWindow',
      )
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
        .toContainEqual(expect.stringContaining('quick-open-aux.txt'))
      await markDocumentUnfocused(child)
      await activateMainWindow(page)

      await installFocusProbe(electronApp)
      await clearFocusRequests(electronApp)

      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.quickOpen')
      })
      await workbench.quickInput.waitForVisible()
      await workbench.quickInput.input.fill('quick-open-aux')
      await expect(
        workbench.quickInput.dialog.getByRole('option', { name: /quick-open-aux\.txt/ }),
      ).toBeVisible()
      await page.keyboard.press('Enter')
      await workbench.quickInput.waitForHidden()

      // Renderer-side group activation alone would leave native focus in main.
      await expectAuxiliaryFocus(electronApp, child, workbench, 'quick-open-aux.txt')
    })

    test('going back to an editor in an auxiliary window focuses that window', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      const alpha = seedFile('history-aux-alpha.txt', 'alpha\n')
      const beta = seedFile('history-aux-beta.txt', 'beta\n')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), alpha)
      await expect(workbench.editor.monacoEditor).toBeVisible()
      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.moveEditorToNewWindow',
      )
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
        .toContainEqual(expect.stringContaining('history-aux-alpha.txt'))
      await markDocumentUnfocused(child)

      await activateMainWindow(page)
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), beta)
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('history-aux-beta.txt')

      await installFocusProbe(electronApp)
      await clearFocusRequests(electronApp)
      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.goBack')
      })

      await expectAuxiliaryFocus(electronApp, child, workbench, 'history-aux-alpha.txt')
    })

    test('Ctrl+Tab switching to an editor in an auxiliary window focuses that window', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      const alpha = seedFile('switch-aux-alpha.txt', 'alpha\n')
      const beta = seedFile('switch-aux-beta.txt', 'beta\n')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), alpha)
      await expect(workbench.editor.monacoEditor).toBeVisible()
      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.moveEditorToNewWindow',
      )
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
        .toContainEqual(expect.stringContaining('switch-aux-alpha.txt'))
      await markDocumentUnfocused(child)

      await activateMainWindow(page)
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), beta)
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('switch-aux-beta.txt')

      await installFocusProbe(electronApp)
      await clearFocusRequests(electronApp)

      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.quickOpenRecentEditor')
      })
      await workbench.quickInput.waitForVisible()
      // Enter unlocks the read-only switcher; typing then narrows it to alpha.
      await page.keyboard.press('Enter')
      await workbench.quickInput.input.fill('switch-aux-alpha')
      await expect(
        workbench.quickInput.dialog.getByRole('option', { name: /switch-aux-alpha\.txt/ }),
      ).toBeVisible()
      await page.keyboard.press('Enter')
      await workbench.quickInput.waitForHidden()

      await expectAuxiliaryFocus(electronApp, child, workbench, 'switch-aux-alpha.txt')
    })

    test('Ctrl+Tab from an auxiliary window focuses a background tab in the main window @regression', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      const background = seedFile('switch-back-bg.txt', 'line one\nline two\nline three\n')
      const mounted = seedFile('switch-back-mounted.txt', 'mounted\n')
      const moved = seedFile('switch-back-moved.txt', 'moved\n')

      for (const [file, name] of [
        [background, 'switch-back-bg.txt'],
        [mounted, 'switch-back-mounted.txt'],
        [moved, 'switch-back-moved.txt'],
      ] as const) {
        await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
        await expect.poll(() => workbench.getActiveEditorUri()).toContain(name)
      }

      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.moveEditorToNewWindow',
      )
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
        .toContainEqual(expect.stringContaining('switch-back-moved.txt'))

      // The auxiliary window must own the active part. Clicking the main editor
      // area first would move it back and hide the bug: the window-activation
      // bridge only writes its preserve intent when the active part changes.
      const token = (await auxWindows(page))[0]!.token
      await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page))[0]?.active ?? false).toBe(true)
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__E2E__!.getWorkbenchWindows().find((w) => w.isMain)?.focusedPart,
          ),
        )
        .toBe(false)
      const mainGroupId = await page.evaluate(
        () => window.__E2E__!.getWorkbenchWindows().find((w) => w.isMain)!.groupIds[0]!,
      )
      await expect
        .poll(() =>
          page.evaluate((id) => window.__E2E__!.getEditorGroupEditorUris(String(id)), mainGroupId),
        )
        .toEqual(
          expect.arrayContaining([
            expect.stringContaining('switch-back-bg.txt'),
            expect.stringContaining('switch-back-mounted.txt'),
          ]),
        )

      // Real gesture, entirely inside the auxiliary document: Ctrl+Tab opens the
      // locked switcher, Enter hands the field over, and releasing Ctrl then
      // cannot accept the highlighted row.
      const quickInput = new QuickInputPO(child)
      await child.keyboard.down('Control')
      await child.keyboard.press('Tab')
      await quickInput.waitForVisible()
      await child.keyboard.press('Enter')
      await expect(quickInput.input).not.toHaveAttribute('readonly', '')
      await child.keyboard.up('Control')

      await quickInput.input.fill('switch-back-bg')
      const rows = quickInput.dialog.getByRole('option')
      await expect.poll(() => rows.count()).toBe(1)
      await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
      await child.keyboard.press('Enter')
      await quickInput.waitForHidden()

      // Regression: focus must land in the late-mounted Monaco of the background
      // tab, not on the group body. The probe's setActiveEditorCursor calls
      // monaco.focus(), so only read the cursor here — ArrowDown proves keyboard
      // input actually reaches the editor.
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.closest('.monaco-editor') !== null))
        .toBe(true)
      await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
      await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()))
        .toEqual({ lineNumber: 1, column: 1 })
      await page.keyboard.press('ArrowDown')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber))
        .toBe(2)

      const main = await page.evaluate(
        () => window.__E2E__!.getWorkbenchWindows().find((w) => w.isMain)!,
      )
      expect(main.active).toBe(true)
      expect(main.focusedPart).toBe(true)
      expect(main.openTargetPart).toBe(true)
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('switch-back-bg.txt')
    })

    test('Ctrl+Shift+E in an auxiliary window reveals Explorer instead of hiding it', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      const sidebarPaneVisible = () =>
        page.evaluate(() => {
          const part = document.querySelector('[data-testid="part-sidebar"]')
          const pane = part?.closest('.split-view-view')
          return pane?.classList.contains('split-view-view-visible') ?? false
        })

      // 在主窗口侧栏放一个真实 DOM 焦点：主窗口退到后台后 activeElement 仍在，
      // 正是旧 toggle 误判为“仍聚焦”的场景。先 blur，避免启动焦点恢复留下的
      // 侧栏焦点让 Show Explorer 直接收起面板。
      await page.evaluate(() => {
        ;(document.activeElement as HTMLElement | null)?.blur()
        document.body.tabIndex = -1
        document.body.focus()
      })
      await workbench.runCommand('workbench.view.explorer')
      await page.getByRole('button', { name: /Open Folder/ }).focus()
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.closest('[data-testid="part-sidebar"]') !== null,
          ),
        )
        .toBe(true)
      await expect.poll(() => workbench.getContextKey<boolean>('sideBarFocus')).toBe(true)
      await expect.poll(sidebarPaneVisible).toBe(true)

      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.newEmptyEditorWindow',
      )
      const token = (await auxWindows(page))[0]!.token
      await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page))[0]?.active ?? false).toBe(true)
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.closest('[data-testid="part-sidebar"]') !== null,
          ),
        )
        .toBe(true)

      await child.keyboard.press('Control+Shift+E')

      // 命令必须显示并聚焦 Explorer（切回主窗口且侧栏仍可见）；旧逻辑会误收起。
      await expect.poll(sidebarPaneVisible).toBe(true)
      await expect
        .poll(() =>
          page.evaluate(() => window.__E2E__!.getWorkbenchWindows().find((w) => w.isMain)?.active),
        )
        .toBe(true)

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })

    test('auxiliary editor area reports editorAreaFocus and focusedPart', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      const file = seedFile('aux-focus-keys.txt', 'keys\n')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
      await expect(workbench.editor.monacoEditor).toBeVisible()
      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.moveEditorToNewWindow',
      )
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
        .toContainEqual(expect.stringContaining('aux-focus-keys.txt'))
      const token = (await auxWindows(page))[0]!.token

      // 先退回主窗口，再真实点击辅助窗口里的编辑器：主文档残留的 activeElement
      // 不能继续占着聚焦判定，辅助窗口的编辑区必须报告聚焦。
      await activateMainWindow(page)
      await expect
        .poll(() =>
          page.evaluate(() => window.__E2E__!.getWorkbenchWindows().find((w) => w.isMain)?.active),
        )
        .toBe(true)
      await child.locator('.monaco-editor').first().click()
      await expect.poll(() => workbench.getContextKey<boolean>('editorAreaFocus')).toBe(true)
      expect(await workbench.getContextKey('focusedPart')).toBe('editorArea')

      // 非 Monaco 元素（标签页按钮）位于编辑区根内，同样算编辑区聚焦。
      await child.getByRole('tab').first().focus()
      await expect
        .poll(() => child.evaluate(() => document.activeElement?.getAttribute('role') === 'tab'))
        .toBe(true)
      await expect.poll(() => workbench.getContextKey<boolean>('editorAreaFocus')).toBe(true)
      expect(await workbench.getContextKey('focusedPart')).toBe('editorArea')

      // 焦点离开编辑区后必须清掉，否则键位会在错误的窗口/区域上继续生效。
      await child.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await expect.poll(() => workbench.getContextKey<boolean>('editorAreaFocus')).toBe(false)
      expect(await workbench.getContextKey('focusedPart')).toBe('')

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })

    test('Ctrl+W after a window round trip focuses and types into the next editor', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      const first = seedFile('aux-close-focus-first.txt', 'first\n')
      const second = seedFile('aux-close-focus-second.txt', 'second\n')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), first)
      await expect(workbench.editor.monacoEditor).toBeVisible()

      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.moveEditorToNewWindow',
      )
      // 移动后辅助窗口处于活动状态，再开第二个文件，让它有两个标签。
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), second)
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
        .toContainEqual(expect.stringContaining('aux-close-focus-second.txt'))
      await expect
        .poll(() => workbench.getActiveEditorUri())
        .toContain('aux-close-focus-second.txt')
      const token = (await auxWindows(page))[0]!.token

      // 真实往返：切回主窗口，再点回辅助窗口的 Monaco。窗口激活只应保留原焦点，
      // 但随后的 Ctrl+W 是关闭标签，必须把焦点交给下一个编辑器。
      await activateMainWindow(page)
      await child.locator('.monaco-editor').first().click()
      await expect.poll(async () => (await auxWindows(page))[0]?.active ?? false).toBe(true)

      await child.keyboard.press('Control+w')
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
        .toHaveLength(1)
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('aux-close-focus-first.txt')
      await expect
        .poll(() =>
          child.evaluate(() => document.activeElement?.closest('.monaco-editor') !== null),
        )
        .toBe(true)

      // 不再点编辑器，直接输入：这是「关闭后能继续敲字」的回归断言。
      await child.keyboard.type('typed-after-close')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()))
        .toContain('typed-after-close')

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })

    test('quick navigate keeps modifier release and Ctrl+P/N in the auxiliary document', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.newEmptyEditorWindow',
      )
      const token = (await auxWindows(page))[0]!.token
      await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page))[0]?.active ?? false).toBe(true)

      const selectedIndex = () =>
        child.evaluate(() => {
          const rows = Array.from(
            document.querySelectorAll('[data-testid="quick-input"] [role="option"]'),
          )
          return rows.findIndex((row) => row.getAttribute('aria-selected') === 'true')
        })

      await child.keyboard.down('Control')
      await child.keyboard.press('Tab')
      const overlay = child.locator('[data-testid="quick-input-overlay"]')
      await expect(overlay).toBeVisible()

      // Ctrl+N / Ctrl+P 由拥有该面板的窗口处理。
      const initial = await selectedIndex()
      await child.keyboard.press('n')
      await expect.poll(selectedIndex).not.toBe(initial)
      await child.keyboard.press('p')
      await expect.poll(selectedIndex).toBe(initial)

      // 松开修饰键会接受高亮行；旧监听挂在主文档，辅助窗口里松手后面板永远不关。
      await child.keyboard.up('Control')
      await expect(overlay).toHaveCount(0)

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })

    test('native titles distinguish main and auxiliary windows and follow editors', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.newEmptyEditorWindow',
      )
      const token = (await auxWindows(page))[0]!.token
      await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)

      const nativeTitles = () =>
        electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((win) => win.getTitle()),
        )
      const mainTitle = await page.title()
      const auxTitles = async () => (await nativeTitles()).filter((t) => t !== mainTitle)
      await expect.poll(auxTitles).toContain('Editor Window')
      expect(mainTitle).not.toContain('Editor Window')

      const first = seedFile('aux-title-first.txt', 'first\n')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), first)
      // 窗口 document.title（popup 的系统标题）和渲染的标题栏都必须带编辑器名；
      // 旧实现会把它覆盖成主工作区标题。
      await expect.poll(() => child.evaluate(() => document.title)).toContain('aux-title-first.txt')
      await expect.poll(auxTitles).toContainEqual(expect.stringContaining('aux-title-first.txt'))

      const second = seedFile('aux-title-second.txt', 'second\n')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), second)
      await expect
        .poll(() => child.evaluate(() => document.title))
        .toContain('aux-title-second.txt')
      await expect.poll(auxTitles).toContainEqual(expect.stringContaining('aux-title-second.txt'))

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })

    test('auxiliary title bar tracks the main title bar theme', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.waitForBootstrapFocusSettled()
      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.newEmptyEditorWindow',
      )
      const auxiliaryTitlebar = child.locator('[data-testid="auxiliary-titlebar"]')
      const mainTitlebar = page.locator('[data-testid="titlebar"]')
      await expect(auxiliaryTitlebar).toBeVisible()

      const backgrounds = async () => ({
        main: await mainTitlebar.evaluate((el) => getComputedStyle(el).backgroundColor),
        auxiliary: await auxiliaryTitlebar.evaluate((el) => getComputedStyle(el).backgroundColor),
      })
      await expect
        .poll(async () => {
          const colors = await backgrounds()
          return colors.main === colors.auxiliary && colors.main !== 'rgba(0, 0, 0, 0)'
        })
        .toBe(true)
      const dark = await backgrounds()

      await page.evaluate(() => window.__E2E__!.whenUserSettingsInitialized())
      await page.evaluate(() =>
        window.__E2E__!.updateConfigValue('workbench.colorTheme', 'Universe Light'),
      )
      await expect
        .poll(async () => {
          const colors = await backgrounds()
          return colors.main === colors.auxiliary && colors.main !== dark.main
        })
        .toBe(true)

      // Frameless on Windows/Linux: the renderer draws the window buttons too.
      const platform = await electronApp.evaluate(() => process.platform)
      if (platform !== 'darwin') {
        await expect(
          auxiliaryTitlebar.getByRole('button', { name: /Minimize|最小化/ }),
        ).toBeVisible()
        await expect(
          auxiliaryTitlebar.getByRole('button', { name: /Maximize|最大化/ }),
        ).toBeVisible()
        await expect(auxiliaryTitlebar.getByRole('button', { name: /Close|关闭/ })).toBeVisible()
      }

      const token = (await auxWindows(page))[0]!.token
      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })
  })

  test('ACP session context menu opens in the auxiliary window', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await openEchoSession(page)
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello from the aux test'))
    await expect(page.getByTestId('acp-user-bar')).toBeVisible({ timeout: 10_000 })

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    const bar = child.getByTestId('acp-user-bar')
    await expect(bar).toBeVisible({ timeout: 10_000 })

    // The session editor is a React portal into the auxiliary document, but the
    // menu is rendered by the main realm. It must follow the host document.
    await bar.click({ button: 'right' })
    const menu = child.locator('[role="menu"]').first()
    await expect(menu).toBeVisible({ timeout: 5000 })
    await expect(menu.getByRole('menuitem', { name: 'Copy Message' })).toBeVisible()
    await expect(page.locator('[role="menu"]')).toHaveCount(0)

    await child.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    const token = (await auxWindows(page))[0]!.token
    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('ACP image preview opens and dismisses in the auxiliary window', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await openEchoSession(page, { ECHO_AGENT_IMAGE: '1' })
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('emit-image:1x1'))
    await expect(page.locator('[data-testid="acp-image-block"]').last()).toBeVisible({
      timeout: 10_000,
    })

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    const image = child.locator('[data-testid="acp-image-block"]').last()
    await expect(image).toBeVisible({ timeout: 10_000 })
    await image.click()

    const preview = child.getByTestId('acp-image-preview-popover')
    await expect(preview).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('acp-image-preview-popover')).toHaveCount(0)

    // Clicking inside the preview is not an outside click, even though the
    // preview element and the listener live in different DOM realms.
    await child.getByTestId('acp-image-preview-stage').click()
    await expect(preview).toBeVisible()

    await child.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)

    const token = (await auxWindows(page))[0]!.token
    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test('notifications raised from an auxiliary window toast there', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await workbench.runCommand('workbench.action.notifications.clearAll')

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.newEmptyEditorWindow',
    )
    const token = (await auxWindows(page))[0]!.token
    await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page))[0]?.active ?? false).toBe(true)

    // Sticky so the 3 s auto-read cannot race the assertion.
    await page.evaluate(() => window.__E2E__!.triggerUnexpectedError('E2E auxiliary toast'))
    const toast = child
      .locator('[data-testid="notification-toast-item"]')
      .filter({ hasText: 'E2E auxiliary toast' })
    await expect(toast).toBeVisible({ timeout: 5000 })
    await expect(
      page
        .locator('[data-testid="notification-toast-item"]')
        .filter({ hasText: 'E2E auxiliary toast' }),
    ).toHaveCount(0)

    await workbench.runCommand('workbench.action.notifications.clearAll')
    await expect(toast).toHaveCount(0)

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })

  test.describe('tab drag and drop across windows', () => {
    // NOTE: Playwright/CDP cannot drive a native OS drag between two Electron
    // BrowserWindows. These tests synthesize HTML5 DragEvents into the live
    // renderer (see the helper docs above), so the drag handlers, shared
    // DragSession, screen-geometry calculation, IPC window creation and editor
    // migration all run for real. They do not pretend to be a native OS drag.
    test('dragging a tab outside every window opens one at the release point', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      const file = seedFile('drag-out.txt', 'drag out\n')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
      await expect(workbench.editor.monacoEditor).toBeVisible()

      const mainRect = await page.evaluate(() => ({
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
      }))
      const releaseX = mainRect.x + mainRect.width + 120
      const releaseY = mainRect.y + Math.round(mainRect.height / 2)

      const windowPromise = electronApp.waitForEvent('window')
      await startTabDrag(page)
      await endTabDrag(page, releaseX, releaseY)
      const child = (await windowPromise) as Page
      await child.waitForLoadState('domcontentloaded')
      await expect(child.locator('[data-testid="part-editorArea"]')).toBeVisible()

      await expect.poll(async () => (await auxWindows(page)).length, { timeout: 15_000 }).toBe(1)
      const [aux] = await auxWindows(page)
      expect(aux!.groups.flatMap((g) => g.editorUris)).toContainEqual(
        expect.stringContaining('drag-out.txt'),
      )
      const mainWindow = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
        (w) => w.isMain,
      )!
      expect(
        await page.evaluate(
          (g) => window.__E2E__!.getEditorGroupEditorUris(String(g)),
          mainWindow.groupIds[0]!,
        ),
      ).toEqual([])

      // The window is created from screenX/screenY (the same coordinate space
      // Electron's BrowserWindow bounds use), not from a guessed offset. The
      // release point here lies beyond the virtual display, so the service's
      // reachable-position clamp applies — a cascade/offset implementation
      // would land somewhere else entirely. Read geometry back from the
      // auxiliary renderer instead of identifying BrowserWindows.
      const auxRect = await child.evaluate(() => ({
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
      }))
      const workArea = await electronApp.evaluate(
        ({ screen }, point) => {
          const display = screen.getDisplayNearestPoint(point)
          return {
            x: display.workArea.x,
            y: display.workArea.y,
            width: display.workArea.width,
            height: display.workArea.height,
          }
        },
        { x: Math.round(releaseX), y: Math.round(releaseY) },
      )
      const expectedX = Math.min(
        Math.max(Math.round(releaseX), workArea.x),
        workArea.x + workArea.width - auxRect.width,
      )
      const expectedY = Math.min(
        Math.max(Math.round(releaseY), workArea.y),
        workArea.y + workArea.height - auxRect.height,
      )
      expect(Math.abs(auxRect.x - expectedX)).toBeLessThanOrEqual(20)
      expect(Math.abs(auxRect.y - expectedY)).toBeLessThanOrEqual(20)

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), aux!.token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })

    test('cancelled drag-out does not create a window', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      const file = seedFile('drag-cancel.txt', 'cancel\n')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
      await expect(workbench.editor.monacoEditor).toBeVisible()

      const mainRect = await page.evaluate(() => ({
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
      }))
      await startTabDrag(page)
      await page.evaluate(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      await endTabDrag(
        page,
        mainRect.x + mainRect.width + 120,
        mainRect.y + Math.round(mainRect.height / 2),
      )

      // No window event within a bounded wait; the source tab stays put.
      await expect(electronApp.waitForEvent('window', { timeout: 1_500 })).rejects.toThrow()
      expect(await auxWindows(page)).toHaveLength(0)
      const mainWindow = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
        (w) => w.isMain,
      )!
      expect(
        await page.evaluate(
          (g) => window.__E2E__!.getEditorGroupEditorUris(String(g)),
          mainWindow.groupIds[0]!,
        ),
      ).toContainEqual(expect.stringContaining('drag-cancel.txt'))
    })

    test('dropping a tab into another window moves it, and an edge drop splits', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      const fileA = seedFile('cross-window-a.txt', 'A\n')
      const fileB = seedFile('cross-window-b.txt', 'B\n')
      // Both tabs live in the main group: opening a file after the auxiliary
      // window exists would target whichever part is globally active.
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), fileA)
      await expect(workbench.editor.monacoEditor).toBeVisible()
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), fileB)
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('cross-window-b.txt')

      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.newEmptyEditorWindow',
      )
      await expect.poll(async () => (await auxWindows(page)).length).toBe(1)

      await startTabDrag(page, 0)
      await dropOnGroupBody(child, 'center')
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
        .toContainEqual(expect.stringContaining('cross-window-a.txt'))
      const mainWindow = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
        (w) => w.isMain,
      )!
      expect(
        await page.evaluate(
          (g) => window.__E2E__!.getEditorGroupEditorUris(String(g)),
          mainWindow.groupIds[0]!,
        ),
      ).toContainEqual(expect.stringContaining('cross-window-b.txt'))

      // A second file dropped on the left edge of the auxiliary group splits
      // that window's group instead of opening yet another window.
      await startTabDrag(page, 0)
      await dropOnGroupBody(child, 'left')
      await expect.poll(async () => (await auxWindows(page))[0]?.groups.length ?? 0).toBe(2)
      const auxUris = (await auxWindows(page))[0]!.groups.flatMap((g) => g.editorUris)
      expect(auxUris).toContainEqual(expect.stringContaining('cross-window-a.txt'))
      expect(auxUris).toContainEqual(expect.stringContaining('cross-window-b.txt'))
      expect(await auxWindows(page)).toHaveLength(1)

      const token = (await auxWindows(page))[0]!.token
      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })

    test('Ctrl-drop copies across windows and keeps the dirty state on both sides', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      const file = seedFile('cross-window-copy.txt', 'original\n')
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), file)
      await workbench.editor.monacoEditor.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('dirty line')
      await expect.poll(() => page.evaluate(() => window.__E2E__!.isActiveEditorDirty())).toBe(true)
      const mainWindow = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
        (w) => w.isMain,
      )!
      const mainGroupId = mainWindow.groupIds[0]!

      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.newEmptyEditorWindow',
      )
      await expect.poll(async () => (await auxWindows(page)).length).toBe(1)

      await startTabDrag(page)
      await dropOnGroupBody(child, 'center', { ctrl: true })

      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [])
        .toContainEqual(expect.stringContaining('cross-window-copy.txt'))
      // The clone starts with pending dirty content and only flips its dirty flag
      // once it mounts and syncs against the model.
      await expect
        .poll(async () => {
          const entry = (await auxWindows(page))[0]
          return (
            entry?.groups.find((g) =>
              g.editorUris.some((uri) => uri.includes('cross-window-copy.txt')),
            )?.activeEditorDirty ?? false
          )
        })
        .toBe(true)
      const [aux] = await auxWindows(page)
      // Copy leaves the source in place, still dirty, and does not create a window.
      const mainUris = await page.evaluate(
        (g) => window.__E2E__!.getEditorGroupEditorUris(String(g)),
        mainGroupId,
      )
      const sourceUri = mainUris.find((uri) => uri.includes('cross-window-copy.txt'))
      expect(sourceUri).toBeDefined()
      expect(await page.evaluate((u) => window.__E2E__!.isEditorUriDirty(u), sourceUri!)).toBe(true)
      expect(await auxWindows(page)).toHaveLength(1)

      // A dragend after a consumed drop must not be treated as a window gesture.
      await endTabDrag(page, 4000, 4000)
      await expect(electronApp.waitForEvent('window', { timeout: 1_000 })).rejects.toThrow()
      expect(await auxWindows(page)).toHaveLength(1)

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), aux!.token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })
  })

  test.describe('workspace restore', () => {
    // Workspace-scope storage is a no-op without an open folder.
    test.use({
      workspaceSeeder: {
        seed(dir: string) {
          writeFileSync(join(dir, 'restore-aux.txt'), 'restore\n')
        },
      },
    })

    test('reload restores a dirty editor into its auxiliary window', async ({
      electronApp,
      workbench,
      page,
      launchWorkspace,
    }) => {
      await workbench.waitForRestored()
      if (!launchWorkspace) throw new Error('workspace seeder did not run')
      await page.evaluate(
        (p) => window.__E2E__!.openFileUri(p),
        launchWorkspace.file('restore-aux.txt'),
      )
      await expect(workbench.editor.monacoEditor).toBeVisible()
      await workbench.editor.monacoEditor.click()
      await page.keyboard.type('typed-before-reload')
      await expect.poll(() => page.evaluate(() => window.__E2E__!.isActiveEditorDirty())).toBe(true)

      await waitForAuxWindow(electronApp, workbench, 'workbench.action.moveEditorToNewWindow')
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups[0]?.activeEditorDirty ?? false)
        .toBe(true)

      await workbench.waitForRestartRestore()
      await expect.poll(async () => (await auxWindows(page)).length, { timeout: 15_000 }).toBe(1)
      const entry = (await auxWindows(page))[0]!
      expect(entry.groups.flatMap((g) => g.editorUris)).toContainEqual(
        expect.stringContaining('restore-aux.txt'),
      )
      // Dirty content is rehydrated asynchronously after the group is restored.
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups[0]?.activeEditorDirty ?? false)
        .toBe(true)

      await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), entry.token)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()))
        .toContain('typed-before-reload')

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), entry.token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })

    test('closing the window migrates a non-active restored untitled buffer', async ({
      electronApp,
      workbench,
      page,
      launchWorkspace,
    }) => {
      await workbench.waitForRestored()
      if (!launchWorkspace) throw new Error('workspace seeder did not run')
      await workbench.runCommand('workbench.action.files.newUntitledFile')
      await expect(workbench.editor.monacoEditor).toBeVisible()
      await workbench.editor.monacoEditor.click()
      await page.keyboard.type('inactive-untitled-must-survive')
      await expect.poll(() => page.evaluate(() => window.__E2E__!.isActiveEditorDirty())).toBe(true)

      await waitForAuxWindow(electronApp, workbench, 'workbench.action.moveEditorToNewWindow')
      // Open a second tab in the same auxiliary group so the untitled buffer is
      // restored as an *inactive* tab and never mounts its Monaco model.
      await page.evaluate(
        (p) => window.__E2E__!.openFileUri(p),
        launchWorkspace.file('restore-aux.txt'),
      )
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups[0]?.editorUris.length ?? 0)
        .toBe(2)
      const beforeReload = (await auxWindows(page))[0]!
      const untitledUri = beforeReload.groups
        .flatMap((g) => g.editorUris)
        .find((uri) => uri.startsWith('untitled:'))
      expect(untitledUri).toBeDefined()

      await workbench.waitForRestartRestore()
      await expect.poll(async () => (await auxWindows(page)).length, { timeout: 15_000 }).toBe(1)
      const restored = (await auxWindows(page))[0]!
      expect(restored.groups.flatMap((g) => g.editorUris)).toContain(untitledUri)
      // The file is the active tab, so the untitled buffer is not mounted.
      expect(restored.groups[0]?.activeEditorDirty).toBe(false)
      expect(await page.evaluate((u) => window.__E2E__!.isEditorUriDirty(u), untitledUri!)).toBe(
        true,
      )

      // Closing the window must treat the restored non-active buffer as dirty
      // and migrate it to the main window instead of closing it as clean.
      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), restored.token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
      const main = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
        (w) => w.isMain,
      )!
      expect(
        await page.evaluate(
          (id) => window.__E2E__!.getEditorGroupEditorUris(String(id)),
          main.groupIds[0]!,
        ),
      ).toContainEqual(untitledUri)
      expect(await page.evaluate((u) => window.__E2E__!.isEditorUriDirty(u), untitledUri!)).toBe(
        true,
      )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()))
        .toContain('inactive-untitled-must-survive')
    })

    test('reload restores an untitled buffer moved to an auxiliary window', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await workbench.runCommand('workbench.action.files.newUntitledFile')
      await expect(workbench.editor.monacoEditor).toBeVisible()
      await workbench.editor.monacoEditor.click()
      await page.keyboard.type('untitled-in-aux')
      await expect.poll(() => page.evaluate(() => window.__E2E__!.isActiveEditorDirty())).toBe(true)

      await waitForAuxWindow(electronApp, workbench, 'workbench.action.moveEditorToNewWindow')
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups[0]?.activeEditorDirty ?? false)
        .toBe(true)

      await workbench.waitForRestartRestore()
      await expect.poll(async () => (await auxWindows(page)).length, { timeout: 15_000 }).toBe(1)
      const entry = (await auxWindows(page))[0]!
      const uris = entry.groups.flatMap((g) => g.editorUris)
      expect(uris).toHaveLength(1)
      expect(uris[0]!.startsWith('untitled:')).toBe(true)
      await expect
        .poll(async () => (await auxWindows(page))[0]?.groups[0]?.activeEditorDirty ?? false)
        .toBe(true)

      await page.evaluate((t) => window.__E2E__!.focusAuxiliaryWindow(t), entry.token)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()))
        .toContain('untitled-in-aux')

      await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), entry.token)
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
    })
  })
})

/**
 * Regression guard for the window a session belongs to. The workspace title is
 * driven by the main part's active editor (not the global activeSession, which
 * follows focus across windows), and OS notifications name the auxiliary window
 * that holds the session's tab so Alt+Tab / the taskbar light up the right one.
 */
test.describe('session window attribution', () => {
  test.describe('window title', () => {
    // The session segment only renders once a workspace is open.
    test.use({
      workspaceSeeder: {
        seed(dir: string) {
          writeFileSync(join(dir, 'attribution-seed.txt'), 'seed\n')
        },
      },
    })

    test('a session moved to an auxiliary window leaves the main title and names the auxiliary one @regression', async ({
      electronApp,
      workbench,
      page,
    }) => {
      await workbench.waitForRestored()
      await openEchoSession(page)

      await expect.poll(async () => page.title(), { timeout: 10_000 }).toContain(' — ')
      const suffix = (await page.title()).split(' — ')[1]!
      const sessionLabel = suffix.replace(/^\S+\s+/, '')
      expect(sessionLabel.length).toBeGreaterThan(0)

      const child = await waitForAuxWindow(
        electronApp,
        workbench,
        'workbench.action.moveEditorToNewWindow',
      )
      await expect.poll(() => auxiliaryHasSessionTab(page)).toBe(true)

      // The auxiliary window names its own session...
      await expect
        .poll(() => child.evaluate(() => document.title), { timeout: 10_000 })
        .toContain(sessionLabel)
      // ...while the main window must not keep showing a session that is no
      // longer in its main part (the old global-activeSession leak).
      await expect.poll(() => page.title()).not.toContain(sessionLabel)
      expect(await page.title()).not.toContain(' — ')

      await page.evaluate(() =>
        window.__E2E__!.runCommand('workbench.action.restoreEditorsToMainWindow'),
      )
      await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
      await expect.poll(async () => page.title(), { timeout: 10_000 }).toContain(sessionLabel)
    })
  })

  test('a session in an auxiliary window requests attention for that window, not the main one @regression', async ({
    electronApp,
    workbench,
    page,
  }) => {
    // macOS attention is app.dock.bounce, a process-wide API the probe cannot
    // attribute to a window; keep the assertion to platforms using flashFrame.
    test.skip(process.platform === 'darwin', 'dock bounce is process-wide on macOS')
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    const supported = await electronApp.evaluate(({ Notification }) => Notification.isSupported())
    test.skip(!supported, 'OS notifications are unsupported in this environment')

    await openEchoSession(page)
    await waitForAuxWindow(electronApp, workbench, 'workbench.action.moveEditorToNewWindow')
    await expect.poll(() => auxiliaryHasSessionTab(page)).toBe(true)

    await installFlashProbe(electronApp)
    await clearFlashRequests(electronApp)
    // The focus gate skips a focused target; drop OS focus from the auxiliary
    // window so the completion toast is decided (E2E runs in silent mode).
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.getURL() === 'about:blank') win.blur()
      }
    })

    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('notify attribution'))

    await expect
      .poll(async () => (await flashRequests(electronApp)).some((r) => r.flag && r.auxiliary), {
        timeout: 15_000,
      })
      .toBe(true)
    expect((await flashRequests(electronApp)).filter((r) => r.flag && !r.auxiliary)).toHaveLength(0)
  })
})
