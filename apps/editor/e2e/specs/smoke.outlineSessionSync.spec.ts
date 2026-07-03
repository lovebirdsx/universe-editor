/*---------------------------------------------------------------------------------------------
 *  Outline ↔ agent-session selection sync smoke (@p1).
 *
 *  Repro for the user-reported bug: moving the session's keyboard selection
 *  (Alt+Down / Alt+Up / Alt+Home / Alt+End) must move the sidebar Outline's
 *  highlight, exactly like follow-cursor tracks a code editor's caret.
 *
 *  The three unit layers (OutlineService / timelineToOutline / ChatBody
 *  controller) each pass in isolation, so the failure only surfaces in a real
 *  Electron run wired end-to-end — hence this smoke rather than another vitest.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@p1 outline ↔ agent session selection sync', () => {
  test('moving the session selection moves the outline highlight', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // Two prompts → a timeline with several distinct rows to move between.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('alpha'))
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('bravo'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 8000 })
      .toEqual([
        { role: 'user', text: 'alpha' },
        { role: 'agent', text: 'echo: alpha' },
        { role: 'user', text: 'bravo' },
        { role: 'agent', text: 'echo: bravo' },
      ])

    // Reveal the Outline view so it renders and its service stays attached.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 8000 })
      .toEqual(expect.arrayContaining(['alpha', 'echo: alpha', 'bravo', 'echo: bravo']))

    // Drive the REAL keyboard the way the user does: focus the chat timeline first
    // (so ACP_NAV_WHEN's `acpChatFocused` gate is satisfied), then press the nav
    // keys. runCommand bypasses that gate; the user's key does not.
    //
    // Note the navigable rows are the *display* timeline — the first user message
    // (`alpha`) is lifted out as the session title, so keyboard navigation runs
    // over [echo: alpha, bravo, echo: bravo]. We drive with Alt+Home / Alt+End,
    // the two nav chords Electron reliably delivers (the Alt+arrow / Alt+letter
    // aliases get eaten by the OS/browser in a real window), and toggle between
    // first and last so a *stuck* highlight can't pass — it has to move both ways.
    await page.locator('[data-testid="acp-timeline"]').click({ position: { x: 5, y: 5 } })

    // Alt+Home → first navigable row; the outline highlight must follow.
    await page.keyboard.press('Alt+Home')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineActiveSymbol()), { timeout: 5000 })
      .toBe('echo: alpha')

    // Alt+End → last row; the highlight must move to it.
    await page.keyboard.press('Alt+End')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineActiveSymbol()), { timeout: 5000 })
      .toBe('echo: bravo')

    // Alt+Home again → back to the first row; proves the highlight tracks each
    // move rather than latching once (the exact bug this smoke guards against).
    await page.keyboard.press('Alt+Home')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineActiveSymbol()), { timeout: 5000 })
      .toBe('echo: alpha')
  })
})
