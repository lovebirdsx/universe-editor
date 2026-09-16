/*---------------------------------------------------------------------------------------------
 *  Config bar keyboard entry smoke (@p0).
 *
 *  The config row under the ACP prompt input used to be mouse-only: every entry
 *  is a native button trigger and its popover's rows were `div[role=option]`
 *  with a mousedown handler, so nothing about the row was reachable from the
 *  keyboard. Tab cannot get there either — the prompt is Monaco, which keeps Tab
 *  for indentation. This spec drives the replacement, Alt+<n>, through the REAL
 *  key layer:
 *
 *    - Alt+<n> opens the n-th entry's popover with the cursor already inside it
 *    - arrows move the cursor and Enter applies the pick — the echo fixture
 *      answers with the updated bag, so the trigger's label must change
 *    - Alt+<m> while a popover is up switches entries directly (no Escape first)
 *    - Escape dismisses and hands the cursor back to the trigger that opened it
 *    - an index past the end reports the real entry count instead of no-oping,
 *      and does NOT leak through to the workbench (quickInputVisible stays false
 *      — a leaked chord would open the command palette instead)
 *    - with the bar squeezed narrow, Alt+<n> reaches an entry that folded into
 *      the "…" panel: the panel opens with that row expanded and the cursor
 *      inside its option list
 *    - the Ctrl movement aliases (Ctrl+N/P = down/up, Ctrl+H/L = collapse/open
 *      the row) work inside an open surface without reaching quick open, and are
 *      gone again once it closes
 *    - whenever a surface hands the cursor back, the focus context keys the chords
 *      are gated on agree with the DOM (see expectFocusKeysAgreeWithDom)
 *
 *  This is the only layer that can cover any of it. The binding lives in the
 *  global keybinding dispatcher (document capture, ahead of every React
 *  handler), the entries address each other by position, and happy-dom has no
 *  key layer at all — the unit tests below it drive the component API directly.
 *
 *  The `when` clause is `editorAreaFocus && activeEditorTypeId == 'acp.session'`,
 *  so the session must stay in the EDITOR area (docking the chat into the
 *  sidebar would push the config bar out of scope by design — see
 *  ACP_EDITOR_ONLY_WHEN) and focus must be put in the editor before pressing.
 *
 *  The echo agent fixture (ECHO_AGENT_CONFIG_OPTIONS=1) advertises six select
 *  options in the order model → mode → thought_level → profile → verbosity →
 *  style; the MCP picker self-hides (no servers) and the sub-agent picker is
 *  claude-code-only, so those six ARE the entry list and Alt+7 is out of range.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

/** Entries the echo fixture's six select options produce, in bar order. */
const ENTRY_COUNT = 6

/** SIDEBAR_MAX (services/layout/layoutConstraints.ts). */
const SIDEBAR_MAX = 1000
/** EDITOR_MIN (same file) — the editor pane keeps this much whatever the sidebar asks for. */
const EDITOR_MIN = 220
/** --activitybar-width (WorkbenchLayout.module.css), outside the Allotment budget. */
const ACTIVITY_BAR = 48

/**
 * How wide to make the primary sidebar so the config bar has to fold.
 *
 * The squeeze works by taking width away from the editor, so the target has to
 * be the largest the layout will actually honour. WorkbenchLayout's programmatic
 * resize computes `center = total − targetSidebar − targetSecondary` and
 * early-returns when that is <= 0, so asking for SIDEBAR_MAX on a display too
 * narrow for it is DROPPED — the editor keeps its width, nothing folds, and the
 * assertion below fails for a reason that has nothing to do with the keyboard.
 * Derived from the live window so it holds on the ~1024-wide Windows CI runner
 * as well as on a wider dev machine (same reason as smoke.agentsConfigBarOverflow).
 */
async function computeSqueezeSize(page: Page): Promise<number> {
  const innerWidth = await page.evaluate(() => window.innerWidth)
  return Math.min(SIDEBAR_MAX, innerWidth - ACTIVITY_BAR - EDITOR_MIN)
}

const modelTrigger = (page: Page) => page.getByTestId('acp-config-model-trigger')
const modelPopover = (page: Page) => page.getByTestId('acp-config-model-popover')
const thoughtPopover = (page: Page) => page.getByTestId('acp-config-thought_level-popover')
/** Row under the keyboard cursor — `data-active` is the cursor, not the selection. */
const cursorRow = (popover: ReturnType<typeof modelPopover>) =>
  popover.locator('[role="option"][data-active="true"]')

/**
 * Put DOM focus inside the session editor, which is what the binding's `when`
 * clause needs and what the user's situation actually is (typing in the prompt).
 * runCommand would bypass the gate entirely, so the keys are pressed for real.
 */
async function focusSessionEditor(page: Page): Promise<void> {
  await page.getByTestId('acp-prompt-drop-host').click()
}

/**
 * Assert the focus context keys and the DOM agree, in ONE atomic read.
 *
 * `editorAreaFocus` gates every chord this spec presses (ACP_EDITOR_ONLY_WHEN), so
 * a key that lags the DOM turns "Alt+<n> did nothing" into a mystery. It used to be
 * book-kept through the focus tracker, whose settle can leave it false while DOM
 * focus already sits in the editor — that lag is this spec's historical flake.
 * Deliberately not a poll: polling here would paper over exactly the lag it exists
 * to catch, and would pass on the buggy build too.
 *
 * Only meaningful right after a real DOM focus move. `Part.focus()` is a DOM no-op
 * on the editor-area / activity-bar / status-bar roots (no tabIndex) yet still
 * fires onDidFocus, so on those paths `editorAreaFocus` reads true while
 * `focusedPart` is '' and the caret is elsewhere — the agreement asserted here does
 * not hold there by design. Both call sites below sit after Escape handed focus
 * back to a real element; do not reuse this as a general-purpose assertion.
 */
async function expectFocusKeysAgreeWithDom(page: Page, activeTestId: string): Promise<void> {
  const snapshot = await page.evaluate(() => ({
    activeTestId: document.activeElement?.getAttribute('data-testid') ?? '(none)',
    focusedPart: window.__E2E__!.getContextKey('focusedPart'),
    editorAreaFocus: window.__E2E__!.getContextKey('editorAreaFocus'),
  }))
  expect(snapshot).toEqual({
    activeTestId,
    focusedPart: 'editorArea',
    editorAreaFocus: true,
  })
}

test.describe('@p0 agents config bar keyboard', () => {
  test('Alt+<n> opens config entries, arrows + Enter pick, Escape returns focus', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    // A late one-shot bootstrap focus restore would steal focus mid-test; gate
    // before driving anything by keyboard (mirrors smoke.agentsMcpDraft).
    await workbench.waitForBootstrapFocusSettled()

    await page.evaluate(([id, p, e]) => window.__E2E__!.installAcpEchoAgent(id, p, e), [
      'echo',
      ECHO_AGENT_PATH,
      { ECHO_AGENT_CONFIG_OPTIONS: '1' },
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 10000 })
      .toBe('acp.session')
    // Session idle flips before the PromptInput's Monaco has mounted; without
    // the host the config bar could still be mid-mount (mirrors
    // smoke.agentsConfigBarOverflow).
    await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })
    await expect(modelTrigger(page)).toBeAttached({ timeout: 5000 })

    await focusSessionEditor(page)

    // Alt+1 → the model entry, cursor seeded on the value in effect. `data-active`
    // is the cursor, so seeding it on the current value (not row 0) is what makes
    // the first arrow press step AWAY from where the user already is — and the
    // ArrowDown below only lands on the other option if it started here.
    await page.keyboard.press('Alt+1')
    await expect(modelPopover(page)).toBeVisible({ timeout: 5000 })
    await expect(cursorRow(modelPopover(page))).toHaveText('opus-4-6')

    // Alt+3 with the popover already up switches straight to another entry
    // rather than closing and reopening — the "don't make me Escape first" path.
    await page.keyboard.press('Alt+3')
    await expect(thoughtPopover(page)).toBeVisible({ timeout: 5000 })
    await expect(modelPopover(page)).toBeHidden({ timeout: 5000 })
    await expect(cursorRow(thoughtPopover(page))).toHaveText('high')

    // ...and Alt+1 comes back, so switching is not one-way.
    await page.keyboard.press('Alt+1')
    await expect(modelPopover(page)).toBeVisible({ timeout: 5000 })

    // Arrow + Enter applies through session/set_config_option; the echo fixture
    // answers with the updated bag, so the trigger label proves the whole chain.
    await page.keyboard.press('ArrowDown')
    await expect(cursorRow(modelPopover(page))).toHaveText('claude-opus-4-6-longterm-support')
    await page.keyboard.press('Enter')
    await expect(modelPopover(page)).toBeHidden({ timeout: 5000 })
    await expect(modelTrigger(page)).toContainText('claude-opus-4-6-longterm-support', {
      timeout: 5000,
    })

    // Escape hands the cursor back to the trigger that opened the surface, so
    // the next arrow key lands where the user left off instead of on <body>.
    await page.keyboard.press('Alt+1')
    await expect(modelPopover(page)).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await expect(modelPopover(page)).toBeHidden({ timeout: 5000 })
    await expect(modelTrigger(page)).toBeFocused()
    // ...and the keys the chords are gated on agree with that DOM read.
    await expectFocusKeysAgreeWithDom(page, 'acp-config-model-trigger')

    // Past the end: the bar reports how many entries the session actually has,
    // and the chord must not fall through to the workbench. Alt+<digit> is
    // unbound elsewhere, so a leak would surface as the command palette opening
    // (a bare printable chord) or as nothing at all.
    await page.keyboard.press(`Alt+${ENTRY_COUNT + 1}`)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getNotifications().map((n) => n.message)), {
        timeout: 5000,
        message: 'an out-of-range index should report the real entry count',
      })
      .toContain(`This session has ${ENTRY_COUNT} config entries.`)
    expect(await page.evaluate(() => window.__E2E__!.getContextKey('quickInputVisible'))).toBe(
      false,
    )

    // Squeeze the editor so the low-priority tail folds into the "…" panel, then
    // Alt+1 — the model entry is no longer in the flex line, so its inline
    // popover has nowhere to anchor and the panel is the only host for it. The
    // target comes from the live window (see computeSqueezeSize): over-asking is
    // dropped, not clamped.
    const squeezeSize = await computeSqueezeSize(page)
    await page.evaluate((value) => window.__E2E__!.setLayoutSize('sidebar', value), squeezeSize)
    const overflowTrigger = page.getByTestId('acp-config-overflow-trigger')
    await expect(overflowTrigger).not.toHaveAttribute('data-empty', 'true', { timeout: 5000 })

    await focusSessionEditor(page)
    await page.keyboard.press('Alt+1')
    const panel = page.getByTestId('acp-config-overflow-panel')
    await expect(panel).toBeVisible({ timeout: 5000 })
    const modelRow = panel.locator('[data-entry-key="model"]')
    await expect(modelRow).toHaveAttribute('aria-expanded', 'true')
    // Alt+<n> means "take me into that entry", so the cursor lands in the
    // expanded body rather than on the row that owns it — seeded on the value
    // in effect, which the pick above moved to the long-term row.
    await expect(modelRow.locator('..').locator('[role="option"][data-active="true"]')).toHaveText(
      'claude-opus-4-6-longterm-support',
    )

    // Ctrl+P / Ctrl+N are the emacs aliases a context menu already answers, taken
    // here on window capture so quick open / new file never see them. The cursor
    // is inside the expanded body, so they must step its options — and the
    // panel's own row listener must stay out of it: both are on window capture at
    // once, so ownership (not registration order) has to decide.
    await page.keyboard.press('Control+p')
    await expect(modelRow.locator('..').locator('[role="option"][data-active="true"]')).toHaveText(
      'opus-4-6',
    )
    await page.keyboard.press('Control+n')
    await expect(modelRow.locator('..').locator('[role="option"][data-active="true"]')).toHaveText(
      'claude-opus-4-6-longterm-support',
    )
    expect(await page.evaluate(() => window.__E2E__!.getContextKey('quickInputVisible'))).toBe(
      false,
    )

    // ← / Ctrl+H collapse the body and hand the cursor back to the rows, → /
    // Ctrl+L open the row under it again — the disclosure pair, on the aliases.
    // The caret has to land on the panel itself: the body is gone, so a caret
    // left inside it would fall to <body> and the stroke below would be owned by
    // nobody.
    await page.keyboard.press('Control+h')
    await expect(modelRow).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toBeVisible()
    await page.keyboard.press('Control+l')
    await expect(modelRow).toHaveAttribute('aria-expanded', 'true')

    // Escape peels one level at a time: the row collapses, the panel stays up.
    await page.keyboard.press('Escape')
    await expect(modelRow).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toBeVisible()
    // Second Escape dismisses, with the cursor on what opened it.
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden({ timeout: 5000 })
    await expect(overflowTrigger).toBeFocused()
    await expectFocusKeysAgreeWithDom(page, 'acp-config-overflow-trigger')

    // The listener is torn down with the surface rather than merely narrowed:
    // with the panel gone Ctrl+P is quick open again.
    await page.keyboard.press('Control+p')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('quickInputVisible')), {
        timeout: 5000,
        message: 'Ctrl+P should be quick open again once the panel is closed',
      })
      .toBe(true)
    await page.keyboard.press('Escape')
  })
})
