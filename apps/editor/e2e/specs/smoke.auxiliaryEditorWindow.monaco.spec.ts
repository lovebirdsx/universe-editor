/*---------------------------------------------------------------------------------------------
 *  Monaco overlays in auxiliary editor windows.
 *
 *  Hover is the one Monaco surface the core (extension-less) smoke suite cannot
 *  exercise: it needs a real language provider. This spec activates the
 *  TypeScript extension only so `editor.action.showHover` has something to
 *  resolve, then verifies the hover widget is created inside the auxiliary
 *  document and never leaks into the main window.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/coreTypescriptApp.js'
import type { ElectronApplication, Page } from '@playwright/test'

const SOURCE = [
  // Explicit type: `const greeting = 42` infers the literal type 42, which
  // would make the "number" assertion below ambiguous.
  'const greeting: number = 42',
  'export function useIt(): number {',
  '  return greeting',
  '}',
  '',
].join('\n')

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

test.describe('@p1 auxiliary window Monaco overlays', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'hover.ts'), SOURCE)
        writeFileSync(
          join(dir, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }, null, 2),
        )
      },
    },
  })

  test('hover for the active editor renders in the auxiliary document', async ({
    electronApp,
    workbench,
    page,
    launchWorkspace,
  }) => {
    // The TypeScript extension spawns a real tsserver.
    test.slow()
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
    await workbench.waitForRestored()
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), launchWorkspace.file('hover.ts'))
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 20_000 })
      .toBe('typescript')

    // Wait for the hover provider to be registered AND tsserver to answer before
    // moving the editor: otherwise the first widget request can race the cold
    // language server and stay hidden on a contended suite.
    const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getHover(u, 1, 7), uri), { timeout: 45_000 })
      .toContain('number')

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    const token = (await page.evaluate(() => window.__E2E__!.getAuxiliaryWindows()))[0]!.token

    await child.locator('.monaco-editor').first().click()
    // Put the cursor on `greeting` (line 1, column 7) and ask Monaco's own hover
    // action for the TS result.
    expect(await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 7))).toBe(true)
    await page.evaluate(() => window.__E2E__!.runCommand('editor.action.showHover'))

    const hover = child.locator('.monaco-hover').first()
    // First tsserver resolution under a parallel suite can take a while; the
    // widget only leaves its `hidden` state once the provider answers.
    await expect(hover).toBeVisible({ timeout: 45_000 })
    await expect(hover).toContainText('number')
    // Ownership: the widget must be mounted in the auxiliary document only.
    await expect(page.locator('.monaco-hover')).toHaveCount(0)

    await child.keyboard.press('Escape')
    // Monaco keeps hidden hover DOM around; visibility is the observable state.
    await expect(hover).toBeHidden()

    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect
      .poll(async () => (await page.evaluate(() => window.__E2E__!.getAuxiliaryWindows())).length)
      .toBe(0)
  })
})
