/*---------------------------------------------------------------------------------------------
 *  Vim mode: code navigation & editing keys (@p1).
 *
 *  Guards the "stay inside the main keyboard" additions: `gd`/`<leader>d` reach
 *  the language service, `%`, `*`/`#`, `o`/`O`, `>>`/`<<` and `<leader>c` drive
 *  Monaco/editor commands from Normal mode. The TypeScript extension is enabled
 *  only so `gd` resolves through a real tsserver.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/coreTypescriptSharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const NAV_BODY = 'export function target() {}\nconst value = target()\n'

const text = (page: Page) => page.evaluate(() => window.__E2E__!.getActiveEditorText())
const cursor = (page: Page) => page.evaluate(() => window.__E2E__!.getActiveEditorCursor())

async function setText(page: Page, body: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((value) => window.__E2E__!.setActiveEditorText(value), body))
    .toBe(true)
}

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

async function openWorkspaceFile(page: Page): Promise<void> {
  const dir = mkTempDir('universe-editor-e2e-vim-navigation-')
  const filePath = join(dir, 'navigation.ts')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }))
  writeFileSync(filePath, NAV_BODY, 'utf8')
  await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
  await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), filePath)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')))
    .toBe(true)
}

test.describe('@p1 vim keymap navigation', () => {
  test('code navigation, label jumps and editing keys stay on the main keyboard', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openWorkspaceFile(page)
    await setVimModeEnabled(page, true)

    await test.step('gd and <leader>d jump to the definition', async () => {
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 10000 })
        .toContain('navigation.ts')
      const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
      // Lazy tsserver warmup: the definition must resolve before `gd` is
      // driven, otherwise the action no-ops on a not-yet-ready language service.
      await expect
        .poll(
          () =>
            page.evaluate(
              ([u, l, c]) => window.__E2E__!.getDefinition(u, l, c).then((r) => r.length > 0),
              [uri, 2, 15] as const,
            ),
          { timeout: 30000, intervals: [500, 1000, 1000, 2000] },
        )
        .toBe(true)

      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 15))
      await page.keyboard.press('g')
      await page.keyboard.press('d')
      await expect.poll(() => cursor(page), { timeout: 20000 }).toMatchObject({ lineNumber: 1 })

      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 15))
      await page.keyboard.press('Space')
      await page.keyboard.press('d')
      await expect.poll(() => cursor(page), { timeout: 20000 }).toMatchObject({ lineNumber: 1 })
    })

    await test.step('% jumps to the matching bracket', async () => {
      await setText(page, 'call(foo)\n')
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 5))
      await page.keyboard.press('%')
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: 1, column: 9 })
      await setText(page, NAV_BODY)
    })

    await test.step('* searches the word under the cursor', async () => {
      await setText(page, 'foo bar foo\n')
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('*')
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: 1, column: 9 })
    })

    await test.step('o opens a new line and enters Insert', async () => {
      await setText(page, 'alpha\nbeta\n')
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('o')
      await page.keyboard.type('inserted')
      await page.keyboard.press('Escape')
      await expect.poll(() => text(page)).toContain('inserted')
      const lines = (await text(page))?.split('\n') ?? []
      expect(lines[0]).toBe('alpha')
      expect(lines[1]).toBe('inserted')
      expect(lines[2]).toBe('beta')
    })

    await test.step('>> indents the current line', async () => {
      await setText(page, 'alpha\n')
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('>')
      await page.keyboard.press('>')
      await expect.poll(() => text(page)).toMatch(/^\s+alpha/)
    })

    await test.step('<leader>c toggles a line comment', async () => {
      await setText(page, 'const value = 1\n')
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('Space')
      await page.keyboard.press('c')
      await expect.poll(() => text(page)).toMatch(/^\s*\/\/\s*const value = 1/)
    })
  })
})
