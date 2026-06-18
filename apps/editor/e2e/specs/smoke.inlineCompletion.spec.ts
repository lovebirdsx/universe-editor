/*---------------------------------------------------------------------------------------------
 *  Inline completion smoke (P1).
 *
 *  Exercises the AI inline-completion wiring that holds without a real model
 *  (a fake provider stands in for the live model):
 *    - the contributed commands are registered (trigger / commit / toggle / pickModel)
 *    - `Alt+\` resolves to the trigger command via KeybindingsRegistry
 *    - ghost text appears and **Tab accepts it** (commits the suggestion)
 *    - the AI status bar entry is present
 *    - the AI quick-settings popover reflects the inline-completion toggle state
 *
 *  The model-dependent ranking/streaming path is covered by unit tests on
 *  InlineCompletionService.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

const TRIGGER = 'ai.inlineCompletion.trigger'
const COMMIT = 'ai.inlineCompletion.commit'
const TOGGLE = 'ai.inlineCompletion.toggle'
const PICK_MODEL = 'ai.inlineCompletion.pickModel'

function writeWorkspace(): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-inline-'))
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'hello \n')
  return { dir: dir.replace(/\\/g, '/'), filePath: filePath.replace(/\\/g, '/') }
}

async function aiEntry(workbench: WorkbenchPO) {
  const entries = await workbench.statusBar.entriesFromProbe()
  return entries.find((e) => e.icon === 'sparkle' && e.alignment === 'right')
}

test.describe('@p1 inline completion', () => {
  test('contributes commands and Tab accepts ghost text', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    for (const id of [TRIGGER, COMMIT, TOGGLE, PICK_MODEL]) {
      await expect
        .poll(() => page.evaluate((cmd) => window.__E2E__!.hasCommand(cmd), id), {
          message: `command ${id} should be registered`,
        })
        .toBe(true)
    }

    // Drive the ghost-text → Tab accept path with a fake provider (no live model).
    const { dir, filePath } = writeWorkspace()
    await workbench.openWorkspace(dir)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await expect.poll(() => workbench.getActiveEditorText()).toBe('hello \n')

    await workbench.focusActiveEditorGroup()
    await workbench.setActiveEditorCursor(1, 7)

    expect(await page.evaluate(() => window.__E2E__!.installFakeInlineCompletion('WORLD'))).toBe(
      true,
    )
    await page.evaluate(
      () => void window.__E2E__!.runCommand('editor.action.inlineSuggest.trigger'),
    )

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveInlineSuggestionText()), {
        message: 'ghost text should appear',
        timeout: 5000,
      })
      .toBe('WORLD')

    await page.keyboard.press('Tab')

    await expect
      .poll(() => workbench.getActiveEditorText(), { message: 'Tab should commit the suggestion' })
      .toBe('hello WORLD\n')
    expect(
      await page.evaluate(() => window.__E2E__!.getActiveInlineSuggestionText()),
    ).toBeUndefined()
  })

  test('Alt+\\ resolves to the trigger command', async ({ workbench }) => {
    await workbench.waitForRestored()
    expect(await workbench.getKeybindingCommandsForKey('alt+\\')).toContain(TRIGGER)
  })

  test('shows the AI status bar entry', async ({ workbench }) => {
    await workbench.waitForRestored()
    const entry = await aiEntry(workbench)
    expect(entry).toBeDefined()
    expect(entry!.alignment).toBe('right')
  })

  test('quick-settings toggle reflects inline-completion state', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const aiButton = page.getByTestId('statusbar-entry-ai')
    await expect(aiButton).toBeVisible()
    await aiButton.click()

    const toggle = page.getByTestId('ai-quick-settings-inline-toggle')
    await expect(toggle).toBeVisible()
    const before = await toggle.getAttribute('aria-checked')

    await workbench.runCommand(TOGGLE)
    await expect.poll(() => toggle.getAttribute('aria-checked')).not.toBe(before)

    // Toggle back so the shared worker instance is left in its default state.
    await workbench.runCommand(TOGGLE)
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(before)
  })
})
