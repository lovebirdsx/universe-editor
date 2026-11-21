/*---------------------------------------------------------------------------------------------
 *  Escape closes the references peek inside an auxiliary editor window.
 *
 *  Electron reports `document.hasFocus() === true` for the main document and every
 *  auxiliary `about:blank` document in the same renderer. Monaco's multi-window
 *  `getActiveDocument()` used to return the first document reporting focus (always
 *  the main window), so auxiliary editors never reported `editorTextFocus`. With
 *  the EditContext host also counted as an input (`inputFocus`), the peek's Escape
 *  binding (`referenceSearchVisible && (editorTextFocus || !inputFocus)`) matched
 *  nothing and the peek could not be dismissed from the host editor.
 *
 *  Guarded by the `lastFocusedWindowId` tracking in patches/monaco-editor.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/coreTypescriptApp.js'
import type { ElectronApplication, Page } from '@playwright/test'

const CHANNELS = [
  'export interface IRenderChannel {',
  '  readonly name: string',
  '  dispose(): void',
  '}',
  '',
  'export class RenderChannel implements IRenderChannel {',
  "  readonly name = 'channel'",
  '  dispose(): void {}',
  '}',
  '',
  'export const channel: IRenderChannel = new RenderChannel()',
  '',
].join('\n')

/** `IRenderChannel` starts at column 18 (`export interface ` is 17 chars). */
const SYMBOL_POSITION = { line: 1, column: 18 } as const

async function waitForAuxWindow(
  electronApp: ElectronApplication,
  workbench: { runCommand(id: string, ...args: unknown[]): Promise<unknown> },
  command: string,
): Promise<Page> {
  const pagePromise = electronApp.waitForEvent('window')
  await workbench.runCommand(command)
  const child = (await pagePromise) as Page
  await child.waitForLoadState('domcontentloaded')
  await expect(child.locator('[data-testid="part-editorArea"]')).toBeVisible()
  return child
}

test.describe('@p1 auxiliary window peek escape', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'channels.ts'), CHANNELS)
        writeFileSync(join(dir, 'other.ts'), 'export const other = 1\n')
        writeFileSync(
          join(dir, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }, null, 2),
        )
      },
    },
  })

  test('Escape closes the references peek in an auxiliary window @regression', async ({
    electronApp,
    workbench,
    page,
    launchWorkspace,
  }) => {
    // Spawns a real tsserver; cold start is slow on contended CI runners.
    test.slow()
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
    await workbench.waitForRestored()

    await page.evaluate(
      (fsPath) => window.__E2E__!.openFileUri(fsPath),
      launchWorkspace.file('other.ts'),
    )
    await page.evaluate(
      (fsPath) => window.__E2E__!.openFileUri(fsPath),
      launchWorkspace.file('channels.ts'),
    )
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 20_000 })
      .toBe('typescript')

    const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getHover(u, 1, 18), uri), {
        timeout: 45_000,
      })
      .toContain('IRenderChannel')

    await page.evaluate(() => window.__E2E__!.updateConfigValue('vim.enabled', false))
    await expect.poll(() => workbench.getContextKey<boolean>('vimEnabled')).toBe(false)

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    await expect(child.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 })
    await child.bringToFront()
    await child.locator('.monaco-editor').first().click()

    await page.evaluate(
      ([line, column]) => window.__E2E__!.setActiveEditorSelection(line, column, line, column),
      [SYMBOL_POSITION.line, SYMBOL_POSITION.column] as const,
    )
    // E2E windows never take real OS focus and every document reports
    // `hasFocus()`, so blur the main document to make the auxiliary window the
    // one key dispatch and active-editor resolution target.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    await child.keyboard.press('Shift+F12')
    await expect(child.locator('.reference-zone-widget')).toBeVisible({ timeout: 30_000 })

    // Clicking the peek's preview/host editor moves focus out of the reference
    // tree; Escape must still close the whole peek.
    await child.evaluate(() =>
      (document.querySelector('.native-edit-context') as HTMLElement | null)?.focus(),
    )
    await child.keyboard.press('Escape')
    await expect(child.locator('.reference-zone-widget')).toBeHidden({ timeout: 15_000 })
  })
})
