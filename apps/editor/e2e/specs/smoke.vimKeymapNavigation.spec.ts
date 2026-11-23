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
import { mkTempDir, type WorkbenchPO } from '@universe-editor/e2e-harness'
import {
  cursor,
  firstVisibleLine,
  lastVisibleLine,
  setText,
  setVimEnabled,
  text,
} from '../pages/vimHelpers.js'

const NAV_BODY = 'export function target() {}\nconst value = target()\n'

/**
 * Keep the panel visible so the first error log does not auto-reveal Output:
 * `ErrorLogAutoRevealContribution` focuses the Output view on that reveal,
 * which steals the editor's keyboard focus mid-test. The workspace switch after
 * `openWorkspace` reloads the persisted layout (panel hidden again), hence the
 * second call right before the viewport assertions.
 */
async function ensurePanelVisible(page: Page, workbench: WorkbenchPO): Promise<void> {
  if (await workbench.getContextKey<boolean>('panelVisible')) return
  await workbench.runCommand('workbench.action.togglePanel')
  await expect.poll(() => workbench.getContextKey<boolean>('panelVisible')).toBe(true)
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
    await ensurePanelVisible(page, workbench)
    await setVimEnabled(page, true)

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

    await test.step('* matches whole words only', async () => {
      await setText(page, 'foo fooBar foo\n')
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('*')
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: 1, column: 12 })
      await page.keyboard.press('n')
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: 1, column: 1 })
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

    await test.step('Ctrl+E/Y scroll the viewport without moving a mid-buffer cursor', async () => {
      // The workspace layout reload may have hidden the panel again; re-open
      // before the first error can reveal (and focus) Output.
      await ensurePanelVisible(page, workbench)
      const body = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')
      await setText(page, `${body}\n`)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(120, 1))
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: 120 })
      // setActiveEditorCursor reveals the line with ScrollType.Immediate, so
      // the viewport is a stable baseline as soon as the cursor lands.
      const before = (await firstVisibleLine(page)) ?? 1
      await page.keyboard.press('Control+e')
      await expect
        .poll(() => firstVisibleLine(page), { intervals: [100, 200, 500] })
        .toBe(before + 1)
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: 120 })

      await page.keyboard.press('Control+y')
      await expect.poll(() => firstVisibleLine(page), { intervals: [100, 200, 500] }).toBe(before)
    })

    await test.step('zt/zz/zb place a line at the viewport edge, moving the cursor only for a count', async () => {
      await page.keyboard.press('z')
      await page.keyboard.press('t')
      await expect.poll(() => firstVisibleLine(page), { intervals: [100, 200, 500] }).toBe(120)
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: 120 })

      await page.keyboard.press('z')
      await page.keyboard.press('b')
      await expect.poll(() => lastVisibleLine(page), { intervals: [100, 200, 500] }).toBe(120)

      await page.keyboard.press('z')
      await page.keyboard.press('z')
      await expect
        .poll(
          async () => {
            const first = await firstVisibleLine(page)
            const last = await lastVisibleLine(page)
            if (first === undefined || last === undefined) return false
            return first <= 120 && last >= 120 && Math.abs(120 - first - (last - 120)) <= 1
          },
          { intervals: [100, 200, 500] },
        )
        .toBe(true)
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: 120 })

      // A count is a target line and also moves the cursor there, like Vim.
      await page.keyboard.press('5')
      await page.keyboard.press('z')
      await page.keyboard.press('t')
      await expect.poll(() => firstVisibleLine(page), { intervals: [100, 200, 500] }).toBe(5)
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: 5 })

      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(120, 1))
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: 120 })
    })

    await test.step('H/M/L jump to the first/middle/last visible line', async () => {
      await page.keyboard.press('z')
      await page.keyboard.press('b')
      await expect.poll(() => lastVisibleLine(page), { intervals: [100, 200, 500] }).toBe(120)

      const first = (await firstVisibleLine(page))!
      const last = (await lastVisibleLine(page))!
      await page.keyboard.press('H')
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: first })

      await page.keyboard.press('L')
      await expect.poll(() => cursor(page)).toMatchObject({ lineNumber: last })

      await page.keyboard.press('M')
      await expect
        .poll(() => cursor(page))
        .toMatchObject({ lineNumber: first + Math.floor((last - first + 1) / 2) })
    })
  })
})
