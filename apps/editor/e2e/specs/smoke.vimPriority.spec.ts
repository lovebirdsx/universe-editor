/*---------------------------------------------------------------------------------------------
 *  Vim priority vs User keybindings (@p0).
 *
 *  One workbench-wide rule: a User binding (weight >= User) wins before Vim
 *  sees the stroke, except for the configured reserved set. These cases write
 *  the real user keybindings.json and verify the executed effect, not just the
 *  registry contents.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'
import { focusExplorerTree, setVimEnabled, statusIcon } from '../pages/vimHelpers.js'

const BODY = 'alpha beta\ngamma delta\n'
const TOGGLE_PANEL = 'workbench.action.togglePanel'

async function writeUserKeybindings(
  electronApp: ElectronApplication,
  entries: readonly { key: string; command: string; when?: string }[],
): Promise<void> {
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  writeFileSync(join(userDataDir, 'keybindings.json'), JSON.stringify(entries, null, 2), 'utf8')
}

async function waitForKeybinding(page: Page, key: string, command: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((candidate) => window.__E2E__!.getKeybindingCommandsForKey(candidate), key),
      { timeout: 10_000, message: `user keybinding ${key} → ${command}` },
    )
    .toContain(command)
}

async function panelVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__E2E__!.getContextKey('panelVisible') as boolean)
}

test.describe('@p0 vim priority', () => {
  // The shared fixture resets settings.json but not keybindings.json; leaving a
  // User `j`/`i` binding behind would leak into the next spec on this worker.
  // Wait for the watcher to apply the reset, otherwise the next test can race it.
  test.afterEach(async ({ electronApp, page }) => {
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    writeFileSync(join(userDataDir, 'keybindings.json'), '[]\n', 'utf8')
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            ['i', 'j'].flatMap((key) => window.__E2E__!.getKeybindingCommandsForKey(key)),
          ),
        { timeout: 10_000 },
      )
      .not.toContain(TOGGLE_PANEL)
  })

  test('a User binding wins over Vim on a list surface', async ({
    page,
    workbench,
    electronApp,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-priority-j-')
    for (const name of ['alpha.txt', 'beta.txt']) {
      writeFileSync(join(dir, name), name, 'utf8')
    }
    await workbench.openWorkspace(dir)
    await focusExplorerTree(page)

    await writeUserKeybindings(electronApp, [
      {
        key: 'j',
        command: TOGGLE_PANEL,
        when: "focusedView == 'workbench.view.explorer.tree' && !editorTextFocus",
      },
    ])
    await waitForKeybinding(page, 'j', TOGGLE_PANEL)

    const before = await panelVisible(page)
    const selected = page.locator('[role="treeitem"][aria-selected="true"]')
    const selectedBefore = await selected.textContent()
    await page.keyboard.press('j')
    await expect.poll(() => panelVisible(page)).toBe(!before)
    // Vim's `j` never ran: the tree selection did not move.
    expect(await selected.textContent()).toBe(selectedBefore)
  })

  test('reserved keys still belong to Vim even when a User binding exists', async ({
    page,
    workbench,
    electronApp,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-priority-i-')
    const filePath = join(dir, 'plain.txt')
    writeFileSync(filePath, BODY, 'utf8')
    await workbench.openWorkspace(dir)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
    await expect.poll(() => statusIcon(page)).toBe('vim-normal')

    await writeUserKeybindings(electronApp, [{ key: 'i', command: TOGGLE_PANEL }])
    await waitForKeybinding(page, 'i', TOGGLE_PANEL)

    const before = await panelVisible(page)
    const textBefore = await page.evaluate(() => window.__E2E__!.getActiveEditorText())
    await page.keyboard.press('i')
    // `i` is reserved: the editor enters Insert, the user command does not run.
    await expect.poll(() => statusIcon(page)).toBe('vim-insert')
    expect(await panelVisible(page)).toBe(before)
    expect(await page.evaluate(() => window.__E2E__!.getActiveEditorText())).toBe(textBefore)
    await page.keyboard.press('Escape')
    await expect.poll(() => statusIcon(page)).toBe('vim-normal')
  })

  test('removing a key from vim.reservedKeys lets the User binding win', async ({
    page,
    workbench,
    electronApp,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    const dir = mkTempDir('universe-editor-e2e-vim-priority-reserved-')
    const filePath = join(dir, 'plain.txt')
    writeFileSync(filePath, BODY, 'utf8')
    await workbench.openWorkspace(dir)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)

    await writeUserKeybindings(electronApp, [{ key: 'i', command: TOGGLE_PANEL }])
    await waitForKeybinding(page, 'i', TOGGLE_PANEL)

    // Default reserved set minus `i`.
    await page.evaluate(() =>
      window.__E2E__!.runCommand('_workbench.updateConfiguration', 'vim.reservedKeys', [
        'escape',
        'ctrl+[',
        'a',
        ':',
        '/',
        '?',
        '<leader>',
      ]),
    )
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__E2E__!.runCommand('_workbench.getConfiguration', 'vim.reservedKeys'),
        ),
      )
      .toEqual(['escape', 'ctrl+[', 'a', ':', '/', '?', '<leader>'])

    // The editor is already Normal; an idle Escape would move focus to the tab strip.
    await expect.poll(() => workbench.getContextKey<boolean>('editorTextFocus')).toBe(true)
    await expect.poll(() => statusIcon(page)).toBe('vim-normal')
    const before = await panelVisible(page)
    const textBefore = await page.evaluate(() => window.__E2E__!.getActiveEditorText())
    await page.keyboard.press('i')
    await expect.poll(() => panelVisible(page)).toBe(!before)
    // The user command ran instead of entering Insert.
    await expect.poll(() => statusIcon(page)).toBe('vim-normal')
    expect(await page.evaluate(() => window.__E2E__!.getActiveEditorText())).toBe(textBefore)
  })
})
