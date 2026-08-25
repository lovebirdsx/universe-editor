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
 *    - wide sidebar → every entry inline, the "…" button in its empty state
 *    - SIDEBAR_MIN (170px) → the bar overflows entirely (the line leaves
 *      ~40px, too narrow even for the highest-priority model trigger)
 *    - a self-calibrated midpoint width → the model keeps its inline slot
 *      while the tail overflows (the priority split itself)
 *    - the overflow panel renders 20+ character option labels, and a pick
 *      through it sends session/set_config_option — the trigger's label
 *      updates (the echo fixture echoes the updated bag)
 *    - widening back returns every entry inline, empties the "…" button and
 *      dismisses the open panel. This last step also guards the re-expand:
 *      the bar must track the sidebar width, not stay collapsed after an
 *      overflow (a flexbox sizing bug found while writing this spec).
 *
 *  Widths are MEASURED, not hard-coded. Entry widths are text-driven, so the
 *  same six entries are materially wider under Windows font metrics than under
 *  Linux/Xvfb — a px threshold calibrated on one platform silently inverts an
 *  assertion on the other (this spec's original 700px wide step did exactly
 *  that, failing every Windows CI run). Two consequences:
 *
 *    - the wide step hides the primary sidebar first. The window is 1280 wide
 *      minus a 48px activity bar, so with the primary sidebar visible the
 *      secondary can never exceed 1232 − 240 − EDITOR_MIN(220) = 772px — too
 *      tight to be font-independent. Hidden, it reaches SIDEBAR_MAX (1000),
 *      leaving the bar ~250px of slack on any platform.
 *    - the priority-split step measures the real entry/gap/button widths and
 *      aims at the midpoint between "only the model fits" and "everything
 *      fits", so both sides of that assertion keep equal margin everywhere.
 *
 *  Reading offsetWidth/clientWidth off the bar's own testid'd elements is
 *  deliberate: those are this feature's layout contract (the packing consumes
 *  exactly these numbers — see configBarLayout.ts), not third-party internals.
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

/** SIDEBAR_MAX — reachable by the secondary sidebar only while the primary one is hidden. */
const WIDE_SIZE = 1000
/** SIDEBAR_MIN. */
const NARROW_SIZE = 170

/** The "…" button. Its empty state is the `data-empty` attribute — the empty button is hidden via CSS, so visibility assertions would misjudge it. */
const overflowTrigger = (page: Page) => page.getByTestId('acp-config-overflow-trigger')
/** Inline entry wrapper (scoped to the bar so the overflow panel's rows, which share `data-entry-key`, never collide). */
const inlineEntry = (page: Page, key: string) =>
  page.getByTestId('acp-config-options-items').locator(`[data-entry-key="${key}"]`)

/** The measurement inputs the packing itself consumes (see splitConfigBarOverflow). */
type ConfigBarMetrics = {
  /** The flex line's content width — what entries have to fit into. */
  clientWidth: number
  /** column-gap between entries. */
  gap: number
  /** The "…" button's width, reserved by the packing whenever anything overflows. */
  buttonWidth: number
  /** Natural width per entry key (overflowed entries stay mounted, so this is always measurable). */
  entryWidths: Record<string, number>
}

async function measureConfigBar(page: Page): Promise<ConfigBarMetrics> {
  return page.evaluate(() => {
    const items = document.querySelector<HTMLElement>('[data-testid="acp-config-options-items"]')!
    const button = document.querySelector<HTMLElement>(
      '[data-testid="acp-config-overflow-trigger"]',
    )
    const entryWidths: Record<string, number> = {}
    for (const el of [...items.querySelectorAll<HTMLElement>('[data-entry-key]')]) {
      entryWidths[el.dataset['entryKey']!] = el.offsetWidth
    }
    return {
      clientWidth: items.clientWidth,
      gap: parseFloat(getComputedStyle(items).columnGap) || 0,
      buttonWidth: button?.offsetWidth ?? 0,
      entryWidths,
    }
  })
}

/**
 * Resize the secondary sidebar and wait for the change to actually reach the DOM.
 * Polling the service value alone is not enough — it settles before Allotment has
 * relaid out, so a measurement taken right after could still read the old width.
 */
async function resizeSecondarySidebar(page: Page, size: number): Promise<void> {
  await page.evaluate((value) => window.__E2E__!.setLayoutSize('secondarySidebar', value), size)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getLayoutSizes().secondarySidebar), {
      timeout: 5000,
      message: `secondarySidebar should settle at ${size}px`,
    })
    .toBe(size)
  await waitForConfigBarDomSettle(page)
}

/**
 * Drive the bar's content width to `targetClientWidth` by resizing the sidebar
 * and correcting on the measured residual.
 *
 * The bar cannot be sized directly and its width does NOT track the sidebar 1:1:
 * it is `flex: 1 1 auto` in a row shared with the send button, usage indicators
 * and so on, several of which also flex, so a 100px narrower sidebar takes some
 * other amount off the bar. Rather than model that, measure and correct — which
 * stays true whatever else lands in that row later.
 */
async function resizeToConfigBarWidth(page: Page, targetClientWidth: number): Promise<number> {
  let size = await page.evaluate(() => window.__E2E__!.getLayoutSizes().secondarySidebar)
  let measured = (await measureConfigBar(page)).clientWidth
  for (let i = 0; i < 5 && Math.abs(measured - targetClientWidth) > 2; i++) {
    const next = Math.round(
      Math.min(WIDE_SIZE, Math.max(NARROW_SIZE, size + (targetClientWidth - measured))),
    )
    if (next === size) break // clamped at a bound — as close as this layout gets
    size = next
    await resizeSecondarySidebar(page, size)
    measured = (await measureConfigBar(page)).clientWidth
  }
  return measured
}

/** Wait until the bar's content width stops changing across animation frames. */
async function waitForConfigBarDomSettle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<number>((resolveWidth) => {
              const read = () =>
                document.querySelector<HTMLElement>('[data-testid="acp-config-options-items"]')!
                  .clientWidth
              const first = read()
              // Two consecutive frames reporting the same width means the
              // relayout (and the overflow re-measure it triggers, which itself
              // runs in a rAF) has come to rest.
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolveWidth(read() === first ? first : -1)),
              )
            }),
        ),
      { timeout: 5000, message: 'config bar width should settle' },
    )
    .toBeGreaterThan(0)
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

    // Hide the primary sidebar so the secondary one can reach SIDEBAR_MAX: with
    // both visible the secondary caps at 1232 − 240 − EDITOR_MIN, which leaves
    // too little slack to be font-independent.
    await page.evaluate(
      () => void window.__E2E__!.runCommand('workbench.action.toggleSidebarVisibility'),
    )
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('sideBarVisible')), {
        timeout: 5000,
        message: 'primary sidebar should hide',
      })
      .toBe(false)

    // Wide sidebar → nothing overflows, the "…" button sits in its empty
    // state. The attribute (not visibility) is the signal: the empty button
    // is hidden via CSS and toBeVisible() would misjudge it.
    await resizeSecondarySidebar(page, WIDE_SIZE)
    await expect(overflowTrigger(page)).toHaveAttribute('data-empty', 'true', { timeout: 5000 })

    // Measure while everything is inline: these are the natural widths the
    // packing consumes, and they are what the midpoint below is derived from.
    const wide = await measureConfigBar(page)
    const keys = Object.keys(wide.entryWidths)
    // `lower` below is the packing's i=0 slot formula, so the midpoint is only
    // the right target while `model` is the highest-priority entry. Assert that
    // rather than leave it implicit.
    expect(keys[0]).toBe('model')
    expect(keys).toContain('style')
    const inlineTotal = keys.reduce(
      (sum, k, i) => sum + (i === 0 ? 0 : wide.gap) + wide.entryWidths[k]!,
      0,
    )
    // Sanity-check the premise of the wide step: everything really does fit,
    // with room to spare. A regression here should read as "the bar no longer
    // fits at max width", not as a mysterious overflow assertion failure.
    expect(inlineTotal).toBeLessThan(wide.clientWidth)

    // SIDEBAR_MIN (170px): the line leaves ~40px, so even the first (model)
    // entry cannot fit and the whole bar overflows. Direction-safe on any
    // platform — wider fonts only overflow harder.
    await resizeSecondarySidebar(page, NARROW_SIZE)
    await expect(overflowTrigger(page)).not.toHaveAttribute('data-empty', 'true', {
      timeout: 5000,
    })
    await expect(inlineEntry(page, 'model')).toHaveAttribute('data-overflowed', 'true', {
      timeout: 5000,
    })
    await expect(inlineEntry(page, 'style')).toHaveAttribute('data-overflowed', 'true', {
      timeout: 5000,
    })

    // The priority split: wide enough for the highest-priority model entry to
    // keep its inline slot, too narrow for the low-priority tail. The two
    // bounds (from splitConfigBarOverflow) are
    //   lower = model + gap + button   (model alone fits, with the button in flow)
    //   upper = inlineTotal            (everything fits, button out of flow)
    // Aiming at their midpoint leaves equal slack on both sides, so neither
    // assertion depends on platform font metrics.
    const lower = wide.entryWidths['model']! + wide.gap + wide.buttonWidth
    const midClientWidth = Math.round((lower + inlineTotal) / 2)
    const reached = await resizeToConfigBarWidth(page, midClientWidth)
    // Both assertions below are only meaningful inside (lower, upper); if the
    // layout could not deliver that, say so instead of failing cryptically.
    expect(reached).toBeGreaterThan(lower)
    expect(reached).toBeLessThan(inlineTotal)
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
    // and the open panel dismisses itself (no overflow left to show). The
    // picked label is wider than the one measured above, which is exactly why
    // this step goes back to the full SIDEBAR_MAX slack rather than to `wide`.
    await resizeSecondarySidebar(page, WIDE_SIZE)
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
