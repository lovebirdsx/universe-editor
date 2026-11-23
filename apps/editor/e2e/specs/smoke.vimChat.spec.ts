/*---------------------------------------------------------------------------------------------
 *  Vim mode — Chat timeline + overlay escape (@p1).
 *
 *  Guards the Wave 2 Chat surface:
 *   - the timeline scroll container registers a stable `list:chat:<sessionId>`
 *     surface; bare j/k scroll the timeline (the chat's own shortcuts), while
 *     gg/G drive the same focused-slot entry point Alt+A/E do
 *   - `m` raises the focused card's context menu from the keyboard
 *   - the prompt input still owns its letters (Vim does not treat it as the
 *     timeline surface), and `workbench.action.agent.focusInput` moves the caret
 *     back from the timeline
 *   - an agents overlay (the config-bar select) closes on Escape while Vim is
 *     enabled — the dispatcher consumes Escape before AnchoredSurface, so the
 *     surface's own `onEscape` has to perform the dismissal.
 *
 *  Rows are keyboard-selected with the same outline the timeline draws for
 *  Alt+J/K, so the assertions do not depend on hashed CSS-module names.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { setVimEnabled } from '../pages/vimHelpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')
const POLL = { timeout: 15000 }

async function startEchoSessionWithOptions(page: Page): Promise<void> {
  await page.evaluate(([id, p, e]) => window.__E2E__!.installAcpEchoAgent(id, p, e), [
    'echo',
    ECHO_AGENT_PATH,
    { ECHO_AGENT_CONFIG_OPTIONS: '1' },
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), POLL)
    .toBe('acp.session')
  await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })
}

/**
 * The keyboard-focused timeline row, read from the outline the surface paints —
 * the same signal smoke.agentFocusToggle uses, so a hashed CSS-module class
 * never has to be guessed.
 */
function focusedTimelineKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>('[data-timeline-key], [data-sticky-key]'),
    )) {
      if (getComputedStyle(el).outlineStyle === 'solid') {
        return el.getAttribute('data-timeline-key') ?? el.getAttribute('data-sticky-key')
      }
    }
    return null
  })
}

async function focusTimelineCard(page: Page): Promise<string> {
  const cards = page.locator('[data-testid="acp-timeline"] [data-timeline-key]')
  await expect(cards.last()).toBeVisible(POLL)
  const count = await cards.count()
  expect(count).toBeGreaterThan(1)
  const last = cards.nth(count - 1)
  await last.click()
  const key = await last.getAttribute('data-timeline-key')
  expect(key).toBeTruthy()
  await expect.poll(() => focusedTimelineKey(page), POLL).toBe(key)
  // The workbench dispatcher reports the surface it just claimed.
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('vimSurfaceId')), POLL)
    .toMatch(/^list:chat:/)
  return key!
}

async function focusPromptInput(page: Page): Promise<void> {
  await page.getByTestId('acp-prompt-drop-host').click()
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), POLL)
    .toBe(true)
}

test.describe('@p1 vim chat', () => {
  test('timeline list surface, card menu and focus-input handoff', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    await startEchoSessionWithOptions(page)
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('first question'))
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('second question'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages().length), POLL)
      .toBe(4)

    const lastKey = await focusTimelineCard(page)

    // Bare j/k are the timeline's scroll shortcuts: they move the viewport and
    // leave the focused row alone (k from the tail would step up if they still
    // ran list.focusUp). gg/G keep driving the focused-slot entry points.
    await page.keyboard.press('k')
    await page.keyboard.press('j')
    await expect.poll(() => focusedTimelineKey(page), POLL).toBe(lastKey)
    await page.keyboard.press('g')
    await page.keyboard.press('g')
    await expect.poll(() => focusedTimelineKey(page), POLL).not.toBe(lastKey)
    await page.keyboard.press('G')
    await expect.poll(() => focusedTimelineKey(page), POLL).toBe(lastKey)

    // `m` (list.contextMenu) opens the focused card's menu, `Escape` closes it.
    await page.keyboard.press('m')
    await expect(page.getByRole('menuitem', { name: 'Copy Message' })).toBeVisible({
      timeout: 5000,
    })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: 'Copy Message' })).toHaveCount(0)

    // `i` (chat.focusInput) lands the caret back in the prompt, which keeps
    // `acpPromptInputFocused` true while the timeline surface stays mounted.
    await page.keyboard.press('i')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), POLL)
      .toBe(true)

    // Typing in the prompt is untouched by the timeline keymap.
    await page.keyboard.type('j')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), POLL)
      .toBe(true)
  })

  test('an agents config overlay closes on Escape while Vim is enabled', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    await startEchoSessionWithOptions(page)

    // Alt+1 is gated on the editor area holding focus with the session editor
    // active; the caret has to really be in the prompt (the key is bridged from
    // Monaco's text-focus event, not from a click on the form).
    await focusPromptInput(page)

    // Alt+1 opens the model entry; the trigger row is outside the timeline, so
    // the Vim list surface is not what handles this stroke.
    await page.keyboard.press('Alt+1')
    const popover = page.getByTestId('acp-config-model-popover')
    await expect(popover).toBeVisible({ timeout: 5000 })

    // The overlay is the innermost surface and owns Escape: `surface.escape`
    // must dismiss it, even though the Vim dispatcher consumed the key before
    // AnchoredSurface's window listener could.
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden({ timeout: 5000 })
    await expect(page.getByTestId('acp-config-model-trigger')).toBeFocused()
  })
})
