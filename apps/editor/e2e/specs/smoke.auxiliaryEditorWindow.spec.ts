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
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkTempDir } from '@universe-editor/e2e-harness'

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

  test('pointer in the main non-editor area routes the next open back to main', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    const moved = seedFile('focus-main-moved.txt', 'moved\n')
    const next = seedFile('focus-main-next.txt', 'next\n')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), moved)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    const token = (await auxWindows(page))[0]!.token
    // Prove the auxiliary window really owns activation before the main click.
    await child.locator('.monaco-editor').first().click()
    await expect.poll(async () => (await auxWindows(page))[0]?.active ?? false).toBe(true)

    // A real pointerdown in the main document's non-editor chrome must switch
    // the active part back without any probe-side activatePart call.
    await page.locator('[data-testid="part-activitybar"]').click({ position: { x: 4, y: 4 } })
    await expect
      .poll(() =>
        page.evaluate(() => window.__E2E__!.getWorkbenchWindows().find((w) => w.isMain)?.active),
      )
      .toBe(true)

    await page.evaluate((p) => window.__E2E__!.openFileUri(p), next)
    const mainWindow = (await page.evaluate(() => window.__E2E__!.getWorkbenchWindows())).find(
      (w) => w.isMain,
    )!
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.__E2E__!.getEditorGroupEditorUris(String(id)),
          mainWindow.groupIds[0]!,
        ),
      )
      .toContainEqual(expect.stringContaining('focus-main-next.txt'))
    expect(
      (await auxWindows(page))[0]?.groups.flatMap((g) => g.editorUris) ?? [],
    ).not.toContainEqual(expect.stringContaining('focus-main-next.txt'))

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
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
    await tabBar.click({ button: 'right', position: { x: 400, y: 12 } })
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
