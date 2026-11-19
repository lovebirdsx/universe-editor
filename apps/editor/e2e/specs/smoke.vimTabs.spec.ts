/*---------------------------------------------------------------------------------------------
 *  Vim chrome surfaces (@p1): editor tabs, ActivityBar and the ViewContainer
 *  header tab strip.
 *
 *  Covers: focusEditorTabs → h/l move between tabs and activate them → x closes;
 *  focusActivityBar → j moves the cursor → Enter opens SCM and focuses its view;
 *  panel container header h/l switch between Output and Terminal.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

async function setVimModeEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(() => window.__E2E__!.whenUserSettingsInitialized())
  await page.evaluate(
    (value) => window.__E2E__!.runCommand('_workbench.updateConfiguration', 'vim.enabled', value),
    enabled,
  )
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.__E2E__!.runCommand('_workbench.getConfiguration', key),
        'vim.enabled',
      ),
    )
    .toBe(enabled)
}

const activeEditorUri = (page: Page) => page.evaluate(() => window.__E2E__!.getActiveEditorUri())

const focusedTestId = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? undefined)

async function openEditors(page: Page, files: readonly string[]): Promise<void> {
  for (const file of files) {
    await page.evaluate((path) => window.__E2E__!.openFileUri(path), file)
    await expect.poll(() => activeEditorUri(page)).toContain(file.split(/[\\/]/).pop()!)
  }
}

test.describe('vim tabs and container headers', () => {
  test('tabs h/l/x, activity bar j/Enter and panel header h/l @p1', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const dir = mkTempDir('universe-editor-e2e-vimtabs-')
    const files = ['a.txt', 'b.txt', 'c.txt'].map((name) => join(dir, name))
    for (const file of files) writeFileSync(file, `${file}\n`, 'utf8')
    await workbench.openWorkspace(dir)
    await setVimModeEnabled(page, true)

    await openEditors(page, files)
    await expect.poll(() => activeEditorUri(page)).toContain('c.txt')

    await test.step('editor tabs: h/l activate adjacent tabs, x closes', async () => {
      await workbench.runCommand('workbench.action.focusEditorTabs')
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
        .toBe('tab')

      await page.keyboard.press('h')
      await expect.poll(() => activeEditorUri(page)).toContain('b.txt')
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
        .toBe('tab')

      await page.keyboard.press('h')
      await expect.poll(() => activeEditorUri(page)).toContain('a.txt')
      await page.keyboard.press('l')
      await expect.poll(() => activeEditorUri(page)).toContain('b.txt')

      await page.keyboard.press('x')
      await expect.poll(() => activeEditorUri(page)).toContain('a.txt')
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
        .toBe('tab')

      // Enter hands focus back to the editor body.
      await page.keyboard.press('Enter')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')))
        .toBe(true)
    })

    await test.step('activity bar: j moves the cursor, Enter opens SCM', async () => {
      await workbench.runCommand('workbench.action.focusActivityBar')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('activityBarFocus')))
        .toBe(true)

      // Move the roving cursor until the SCM item owns focus; the container
      // list depends on which extensions are active in the core fixture.
      for (let i = 0; i < 12; i++) {
        if ((await focusedTestId(page)) === 'activitybar-item-workbench.view.scm') break
        await page.keyboard.press('j')
      }
      expect(await focusedTestId(page)).toBe('activitybar-item-workbench.view.scm')

      await page.keyboard.press('Enter')
      await expect
        .poll(() => workbench.sideBar.root.getAttribute('data-active-view-container'))
        .toBe('workbench.view.scm')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('sideBarFocus')))
        .toBe(true)
    })

    await test.step('panel container header: h/l switch Output and Terminal', async () => {
      await workbench.runCommand('workbench.action.focusPanel')
      await workbench.panel.waitForVisible()
      await workbench.panel.waitForActiveTab('workbench.view.output')

      await workbench.runCommand('workbench.action.focusViewContainerTabs')
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
        .toBe('tab')

      await page.keyboard.press('l')
      await expect
        .poll(() => workbench.panel.root.getAttribute('data-active-view-container'))
        .toBe('workbench.view.terminal')

      await page.keyboard.press('h')
      await expect
        .poll(() => workbench.panel.root.getAttribute('data-active-view-container'))
        .toBe('workbench.view.output')
    })
  })
})
