/*---------------------------------------------------------------------------------------------
 *  Config bar single-line overflow smoke test (@p1).
 *
 *  The config row under the ACP prompt input is a strict single line: entry
 *  order (model → mode → thought_level → custom… → MCP) is the priority
 *  order, and when the sidebar is too narrow the low-priority tail folds
 *  into a "…" overflow panel instead of wrapping onto a second line. This
 *  spec drives the real layout widths through the LayoutService and pins the
 *  fold/unfold contract end to end:
 *
 *    - wide sidebar (700px) → every entry inline, the "…" button in its
 *      empty state. Measured: the six entries take ~490px natural, and the
 *      bar leaves ~35px of fixed chrome (… button + send/collapse), so
 *      600px is not enough for the last entry — 700px leaves ~80px margin.
 *    - SIDEBAR_MIN (170px) → the bar overflows entirely (the line leaves
 *      ~40px, too narrow even for the highest-priority model trigger, which
 *      is ~100px natural) — so the priority split itself is asserted at
 *      300px, where the model keeps its inline slot and the tail overflows.
 *    - the overflow panel renders 20+ character option labels, and a pick
 *      through it sends session/set_config_option — the trigger's label
 *      updates (the echo fixture echoes the updated bag)
 *    - widening back returns every entry inline, empties the "…" button and
 *      dismisses the open panel. This last step also guards the re-expand:
 *      the bar must track the sidebar width, not stay collapsed after an
 *      overflow (a flexbox sizing bug found while writing this spec).
 *
 *  The echo agent fixture (ECHO_AGENT_CONFIG_OPTIONS=1) advertises six
 *  select options. The MCP picker self-hides (no servers configured) and
 *  the sub-agent picker is claude-code-only, so the bar contains exactly
 *  the six option entries.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

/** The "…" button. Its empty state is the `data-empty` attribute — the empty button is hidden via CSS, so visibility assertions would misjudge it. */
const overflowTrigger = (page: Page) => page.getByTestId('acp-config-overflow-trigger')
/** Inline entry wrapper (scoped to the bar so the overflow panel's rows, which share `data-entry-key`, never collide). */
const inlineEntry = (page: Page, key: string) =>
  page.getByTestId('acp-config-options-items').locator(`[data-entry-key="${key}"]`)

async function setSecondarySidebarSize(page: Page, size: number): Promise<void> {
  await page.evaluate((value) => window.__E2E__!.setLayoutSize('secondarySidebar', value), size)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getLayoutSizes().secondarySidebar), {
      timeout: 3000,
      message: `secondarySidebar should settle at ${size}px`,
    })
    .toBe(size)
}

test.describe('@p1 agents config bar overflow', () => {
  test('low-priority tail folds into the overflow panel on narrow sidebars and restores', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    // A late one-shot bootstrap focus restore would steal focus mid-test; gate
    // before driving the layout (mirrors smoke.agentsMcpDraft).
    await workbench.waitForBootstrapFocusSettled()

    // Dock the chat into the secondary sidebar (the config bar lives in the
    // prompt input, so the sidebar layout is what constrains its width).
    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('acp.chat.enableSidebarLocation', true),
    )
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpChatSidebarEnabled')), {
        timeout: 5000,
      })
      .toBe(true)
    await page.evaluate(
      () => void window.__E2E__!.runCommand('workbench.action.agent.toggleChatLocation'),
    )
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpChatLocation')), {
        timeout: 5000,
      })
      .toBe('sidebar')

    // Echo agent advertising six select config options.
    await page.evaluate(([id, p, e]) => window.__E2E__!.installAcpEchoAgent(id, p, e), [
      'echo',
      ECHO_AGENT_PATH,
      { ECHO_AGENT_CONFIG_OPTIONS: '1' },
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 10000 })
      .toBe('idle')
    // Session idle flips before the PromptInput's Monaco has mounted — without
    // waiting for the host, the config bar could still be mid-mount (mirrors
    // smoke.agentsMcpDraft). Also wait for the first entry to render so the
    // option bag has been applied.
    await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('acp-config-model-trigger')).toBeAttached({ timeout: 5000 })

    // Wide sidebar → nothing overflows, the "…" button sits in its empty
    // state. The attribute (not visibility) is the signal: the empty button
    // is hidden via CSS and toBeVisible() would misjudge it.
    await setSecondarySidebarSize(page, 700)
    await expect(overflowTrigger(page)).toHaveAttribute('data-empty', 'true', { timeout: 5000 })

    // SIDEBAR_MIN (170px): the line leaves ~40px, so even the first (model)
    // entry — ~100px natural — cannot fit and the whole bar overflows.
    await setSecondarySidebarSize(page, 170)
    await expect(overflowTrigger(page)).not.toHaveAttribute('data-empty', 'true', {
      timeout: 5000,
    })
    await expect(inlineEntry(page, 'model')).toHaveAttribute('data-overflowed', 'true', {
      timeout: 5000,
    })
    await expect(inlineEntry(page, 'style')).toHaveAttribute('data-overflowed', 'true', {
      timeout: 5000,
    })

    // 300px: wide enough for the highest-priority model entry to keep its
    // inline slot while the low-priority tail still overflows — the priority
    // split the packing guarantees.
    await setSecondarySidebarSize(page, 300)
    await expect(inlineEntry(page, 'model')).not.toHaveAttribute('data-overflowed', 'true', {
      timeout: 5000,
    })
    await expect(inlineEntry(page, 'style')).toHaveAttribute('data-overflowed', 'true', {
      timeout: 5000,
    })

    // Pick through the overflow panel. The expanded row renders 20+ character
    // labels, and picking sends session/set_config_option — the echo fixture
    // applies it and answers with the updated bag, so the (still overflowed)
    // trigger's label must show the new value. The pick targets the moderate
    // label on purpose: the 32-character one would make the bar wider than
    // any sidebar can clear (see the final recovery step).
    await overflowTrigger(page).click()
    const panel = page.getByTestId('acp-config-overflow-panel')
    await expect(panel).toBeVisible({ timeout: 5000 })
    await panel.locator('[data-entry-key="style"]').click()
    await expect(
      panel.getByRole('option', { name: 'maximally creative exploration' }),
    ).toBeVisible()
    await panel.getByRole('option', { name: 'max creative' }).click()
    await expect(page.getByTestId('acp-config-style-trigger')).toContainText('max creative', {
      timeout: 5000,
    })

    // Widen back: every entry returns inline, the "…" button empties again
    // and the open panel dismisses itself (no overflow left to show).
    await setSecondarySidebarSize(page, 700)
    await expect(overflowTrigger(page)).toHaveAttribute('data-empty', 'true', { timeout: 5000 })
    await expect(inlineEntry(page, 'model')).not.toHaveAttribute('data-overflowed', 'true', {
      timeout: 5000,
    })
    await expect(inlineEntry(page, 'style')).not.toHaveAttribute('data-overflowed', 'true', {
      timeout: 5000,
    })
    await expect(panel).toBeHidden({ timeout: 5000 })
  })
})
