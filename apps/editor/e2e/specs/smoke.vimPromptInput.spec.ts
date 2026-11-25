/*---------------------------------------------------------------------------------------------
 *  Vim mode — the session prompt input (@p1).
 *
 *  The prompt is an embedded Monaco editor, so it joins the existing `editor`
 *  Vim surface: it must open in Insert, let the editor core own Normal mode,
 *  yield its own popover keys (ArrowUp / Escape) to the suggestion commands, and
 *  hand focus back to the timeline on an idle Normal Escape.
 *
 *  Assertions read the draft cache / context keys / status bar through
 *  `window.__E2E__`; nothing pokes at Monaco's internal DOM.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { expectStableFor, setVimEnabled, statusIcon, statusText } from '../pages/vimHelpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')
const POLL = { timeout: 15000 }

async function startEchoSession(page: Page): Promise<void> {
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), POLL)
    .toBe('acp.session')
  await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })
}

async function focusPrompt(page: Page): Promise<void> {
  await page.getByTestId('acp-prompt-drop-host').click()
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), POLL)
    .toBe(true)
  // The surface reports Insert as soon as focus lands, before any stroke.
  await expect.poll(() => statusIcon(page), POLL).toBe('vim-insert')
}

const promptText = (page: Page) => page.evaluate(() => window.__E2E__!.getAcpPromptText())
const messageCount = (page: Page) => page.evaluate(() => window.__E2E__!.getAcpMessages().length)
const popupVisible = (page: Page) =>
  page.evaluate(() => window.__E2E__!.getContextKey('acpPromptPopupVisible') === true)

test.describe('vim prompt input', () => {
  test('opens in Insert while the editor core owns Normal mode @p1', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    await startEchoSession(page)
    await focusPrompt(page)
    expect(await statusText(page)).toBe('INSERT')

    await page.keyboard.type('abc')
    await expect.poll(() => promptText(page), POLL).toBe('abc')

    // Escape enters Normal; `x` / `u` are the editor core's commands, and their
    // writes flow back through PromptInput's draft cache.
    await page.keyboard.press('Escape')
    await expect.poll(() => statusIcon(page), POLL).toBe('vim-normal')
    await page.keyboard.press('x')
    await expect.poll(() => promptText(page), POLL).toBe('ab')
    await page.keyboard.press('u')
    await expect.poll(() => promptText(page), POLL).toBe('abc')

    // Insert exits sit one column left, so `a` appends after the caret.
    await page.keyboard.press('a')
    await expect.poll(() => statusIcon(page), POLL).toBe('vim-insert')
    await page.keyboard.type('d')
    await expect.poll(() => promptText(page), POLL).toBe('abcd')

    // Shift+Enter stays Monaco's newline; `gg` / `dd` / `u` work across lines.
    // Monaco may keep whitespace around the break, so compare against what it
    // actually produced instead of assuming a bare `\nsecond`.
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('second')
    await expect.poll(() => promptText(page), POLL).toMatch(/^abcd[^\S\n]*\n[^\S\n]*second$/)
    const twoLines = await promptText(page)
    const secondLine = twoLines.split('\n')[1] ?? ''
    await page.keyboard.press('Escape')
    await expect.poll(() => statusIcon(page), POLL).toBe('vim-normal')
    await page.keyboard.press('g')
    await page.keyboard.press('g')
    await page.keyboard.press('d')
    await page.keyboard.press('d')
    await expect.poll(() => promptText(page), POLL).toBe(secondLine)
    await page.keyboard.press('u')
    await expect.poll(() => promptText(page), POLL).toBe(twoLines)
  })

  test('the prompt popover owns its keys above Vim @p1', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    await startEchoSession(page)
    await focusPrompt(page)

    // A committed prompt becomes the history entry ArrowUp reopens. Keep it
    // over `acp.prompt.confirmShortFirstMessageLength` (default 20) so the
    // first-message confirmation dialog does not interpose.
    await page.keyboard.type('history seed for the popover')
    // EditContext input settles asynchronously; wait for the draft before Enter
    // or submit() would still see an empty React text state.
    await expect.poll(() => promptText(page), POLL).toBe('history seed for the popover')
    await page.keyboard.press('Enter')
    await expect.poll(() => promptText(page), POLL).toBe('')
    await expect.poll(() => messageCount(page), POLL).toBe(2)
    await focusPrompt(page)

    await page.keyboard.press('ArrowUp')
    await expect.poll(() => popupVisible(page), POLL).toBe(true)
    expect(await statusIcon(page)).toBe('vim-insert')

    // First Escape closes only the popover; the caret stays in Insert.
    await page.keyboard.press('Escape')
    await expect.poll(() => popupVisible(page), POLL).toBe(false)
    expect(await statusIcon(page)).toBe('vim-insert')

    // Second Escape is the surface's own Insert exit.
    await page.keyboard.press('Escape')
    await expect.poll(() => statusIcon(page), POLL).toBe('vim-normal')
  })

  test('Insert Enter sends, Normal Enter does not, idle Escape returns to the timeline @p1', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await setVimEnabled(page, true)
    await startEchoSession(page)
    await focusPrompt(page)

    // Over the first-message confirmation threshold (default 20 characters).
    await page.keyboard.type('hello agent from the vim prompt')
    await expect.poll(() => promptText(page), POLL).toBe('hello agent from the vim prompt')
    await page.keyboard.press('Enter')
    await expect.poll(() => promptText(page), POLL).toBe('')
    await expect.poll(() => messageCount(page), POLL).toBe(2)
    const settled = await messageCount(page)

    await focusPrompt(page)
    await page.keyboard.press('Escape')
    await expect.poll(() => statusIcon(page), POLL).toBe('vim-normal')

    // Normal Enter is Vim's `enter` motion (next line), never a submit.
    await page.keyboard.press('Enter')
    await expectStableFor(() => messageCount(page), settled, 700)

    // An idle Normal Escape leaves the input for the timeline.
    await page.keyboard.press('Escape')
    await expect.poll(() => workbench.getFocusedChatSurface(), POLL).toBe('timeline')
  })
})
