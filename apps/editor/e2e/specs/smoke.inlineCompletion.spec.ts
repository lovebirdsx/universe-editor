/*---------------------------------------------------------------------------------------------
 *  Inline completion smoke (P1).
 *
 *  Exercises the AI inline-completion wiring that holds without a real model
 *  (a fake provider stands in for the live model):
 *    - the contributed commands are registered (trigger / commit / toggle / pickModel)
 *    - `Alt+\` resolves to the trigger command via KeybindingsRegistry
 *    - ghost text appears and **Tab accepts it** (commits the suggestion)
 *    - the AI button is present in the status bar
 *    - the AI quick-settings popover reflects the inline-completion toggle state
 *
 *  The model-dependent ranking/streaming path is covered by unit tests on
 *  InlineCompletionService.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const TRIGGER = 'ai.inlineCompletion.trigger'
const COMMIT = 'ai.inlineCompletion.commit'
const TOGGLE_EDITOR = 'ai.inlineCompletion.toggleInEditor'
const TOGGLE_SESSION = 'ai.inlineCompletion.toggleInSession'
const PICK_MODEL = 'ai.inlineCompletion.pickModel'
const ENABLED_IN_EDITOR_KEY = 'ai.inlineCompletion.enabledInEditor'

function writeWorkspace(): { dir: string; filePath: string } {
  const dir = mkTempDir('universe-editor-e2e-inline-')
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'hello \n')
  return { dir: dir.replace(/\\/g, '/'), filePath: filePath.replace(/\\/g, '/') }
}

test.describe('@p1 inline completion', () => {
  test('contributes commands and Tab accepts ghost text', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    for (const id of [TRIGGER, COMMIT, TOGGLE_EDITOR, TOGGLE_SESSION, PICK_MODEL]) {
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
      .poll(() => workbench.getActiveEditorText(), {
        message: 'Tab should commit the suggestion',
      })
      .toBe('hello WORLD\n')
    expect(
      await page.evaluate(() => window.__E2E__!.getActiveInlineSuggestionText()),
    ).toBeUndefined()
  })

  test('Alt+\\ resolves to the trigger command', async ({ workbench }) => {
    await workbench.waitForRestored()
    expect(await workbench.getKeybindingCommandsForKey('alt+\\')).toContain(TRIGGER)
  })

  test('shows the AI button in the status bar', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await expect(page.getByTestId('statusbar-ai-button')).toBeVisible()
  })

  test('quick-settings checkboxes reflect per-scope inline-completion state', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const aiButton = page.getByTestId('statusbar-ai-button')
    await expect(aiButton).toBeVisible()
    await aiButton.click()

    const editorToggle = page.getByTestId('ai-quick-settings-inline-toggle-editor')
    const sessionToggle = page.getByTestId('ai-quick-settings-inline-toggle-session')
    await expect(editorToggle).toBeVisible()
    await expect(sessionToggle).toBeVisible()

    // Defaults: editor scope on, session scope off.
    await expect(editorToggle).toBeChecked()
    await expect(sessionToggle).not.toBeChecked()

    // Toggling the editor scope flips only its own checkbox and persists the
    // editor key to the global User layer (origin 'user' proves both the write
    // and the cleared workspace override at once).
    await workbench.runCommand(TOGGLE_EDITOR)
    await expect(editorToggle).not.toBeChecked()
    await expect(sessionToggle).not.toBeChecked()
    await expect
      .poll(() =>
        page.evaluate((k) => window.__E2E__!.getConfigurationValueOrigin(k), ENABLED_IN_EDITOR_KEY),
      )
      .toBe('user')

    // Toggle back so the shared worker instance is left in its default state.
    await workbench.runCommand(TOGGLE_EDITOR)
    await expect(editorToggle).toBeChecked()
    await expect
      .poll(() =>
        page.evaluate((k) => window.__E2E__!.getConfigurationValueOrigin(k), ENABLED_IN_EDITOR_KEY),
      )
      .toBe('user')
  })
})
