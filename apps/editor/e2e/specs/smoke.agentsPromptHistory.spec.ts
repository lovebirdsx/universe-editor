/*---------------------------------------------------------------------------------------------
 *  ACP prompt-history navigation smoke (@p1).
 *
 *  Regression: after the prompt input became a Monaco editor, pressing ArrowUp on
 *  the first line should open the input-history popover and repeated ArrowUp
 *  should walk back through older entries. The bug: the popover either never
 *  showed or got stuck on the newest entry.
 *
 *  This drives the FULL real path — keyboard into the editContext Monaco editor,
 *  Enter to submit (so AcpPromptHistoryService.push actually records the entry),
 *  then ArrowUp routed through the global keybinding handler — because the
 *  `sendAcpPrompt` probe calls session.sendPrompt directly and would bypass the
 *  history recording that submit performs.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

// Bring up a session with two recorded history entries ('first prompt' newest-
// last so history ends up ['second prompt','first prompt'] newest-first), typed
// and submitted through the real Monaco input so AcpPromptHistoryService.push
// records them (the sendAcpPrompt probe would bypass submit).
async function seedTwoHistoryEntries(page: Page, workbench: WorkbenchPO): Promise<void> {
  await workbench.waitForRestored()

  // Disable the short-first-message confirmation so Enter submits without a
  // blocking dialog (the prompts below are shorter than the default threshold).
  await page.evaluate(() =>
    window.__E2E__!.updateConfigValue('acp.prompt.confirmShortFirstMessageLength', 0),
  )

  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.openView'))
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.newSession'))
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
    .toBe(1)

  const promptHost = page.getByTestId('acp-prompt-drop-host')
  await expect(promptHost).toBeVisible({ timeout: 10000 })

  const typeAndSend = async (text: string): Promise<void> => {
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')), {
        timeout: 5000,
      })
      .toBe(true)
    await page.keyboard.type(text)
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText())).toBe(text)
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText())).toBe('')
  }

  await typeAndSend('first prompt')
  await typeAndSend('second prompt')
}

test.describe('@p1 agents prompt history', () => {
  test('ArrowUp opens the history popover and walks back through older entries @regression', async ({
    page,
    workbench,
  }) => {
    await seedTwoHistoryEntries(page, workbench)

    // Type a fresh draft, then ArrowUp on the first line opens history.
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')))
      .toBe(true)
    await page.keyboard.type('draft in progress')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()))
      .toBe('draft in progress')

    // Move the caret to the very start so ArrowUp sits on the first visual row.
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowUp')

    // The history popover must appear (this is the "弹窗不出来" symptom).
    const popover = page.getByTestId('acp-history-popover')
    await expect(popover).toBeVisible({ timeout: 5000 })
    // …seeded on the newest entry.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()))
      .toBe('second prompt')

    // The list floats above the input, so it grows bottom-up: oldest at the top,
    // newest at the bottom (nearest the input). The newest entry is highlighted.
    const rows = popover.getByRole('option')
    await expect(rows).toHaveText(['first prompt', 'second prompt'])
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')

    // Repeated ArrowUp must walk to the OLDER entry (visually up), not stay stuck.
    await page.keyboard.press('ArrowUp')
    await expect(popover).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()))
      .toBe('first prompt')
    // Highlight moved up to the top (oldest) row.
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true')
  })

  test('a stationary cursor under the popover does not hijack keyboard selection @regression', async ({
    page,
    workbench,
  }) => {
    // The popover pops up above the input, often right under the resting cursor.
    // A synthetic mouseenter on the row beneath the cursor must NOT steal the
    // selection — ArrowUp still starts from the newest entry.
    await seedTwoHistoryEntries(page, workbench)

    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')))
      .toBe(true)
    await page.keyboard.type('draft in progress')
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowUp')

    const popover = page.getByTestId('acp-history-popover')
    await expect(popover).toBeVisible({ timeout: 5000 })
    const rows = popover.getByRole('option')
    await expect(rows).toHaveText(['first prompt', 'second prompt'])

    // Simulate the popover appearing under a STILL cursor: the browser fires a
    // synthetic mouseenter (no mousemove) for the row that lands beneath the
    // pointer. Dispatch that on the top (oldest) row — it must NOT steal the
    // keyboard selection, which stays on the newest (bottom) row.
    await rows.nth(0).dispatchEvent('mouseenter')
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'false')

    // And ArrowUp steps from the newest, not from the cursor's row.
    await page.keyboard.press('ArrowUp')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()))
      .toBe('first prompt')
  })
})
