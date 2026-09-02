/*---------------------------------------------------------------------------------------------
 *  Output level filter on the aggregated "All" channel (P1).
 *
 *  Reproduces two reported symptoms: with only Warning/Error checked, info lines
 *  keep rendering, and toggling a level does not take effect while the log is
 *  still streaming. Both are asserted against the lines the Monaco editor
 *  actually renders (getVisibleOutputLines), not against the computed ranges —
 *  a filter that is computed but never applied must fail here.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'
import type { Page } from '@playwright/test'

/** LogLevel: Off=0 Trace=1 Debug=2 Info=3 Warning=4 Error=5 */
const HIDE_BELOW_WARNING = [1, 2, 3]

const ALL_CHANNEL = 'All'

async function showOutputOnAllChannel(page: Page): Promise<void> {
  if (!(await page.evaluate(() => window.__E2E__!.getContextKey('panelVisible') === true))) {
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.togglePanel'))
  }
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('panelVisible') === true))
    .toBe(true)
  await expect
    .poll(
      () =>
        page.evaluate(
          (name) => window.__E2E__!.getOutputChannelNames().includes(name),
          ALL_CHANNEL,
        ),
      { timeout: 15_000 },
    )
    .toBe(true)
  await page.evaluate((name) => window.__E2E__!.setActiveOutputChannel(name), ALL_CHANNEL)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveOutputChannelName()))
    .toBe(ALL_CHANNEL)
  // The editor mounts asynchronously (Monaco is a dynamic import).
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getVisibleOutputLines().length), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
}

/** 自动揭示等路径可能在测试中途切走 active channel；发现偏离就切回 "All" 并确认。 */
async function ensureAllChannelActive(page: Page): Promise<void> {
  const active = await page.evaluate(() => window.__E2E__!.getActiveOutputChannelName())
  if (active !== ALL_CHANNEL) {
    await page.evaluate((name) => window.__E2E__!.setActiveOutputChannel(name), ALL_CHANNEL)
  }
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveOutputChannelName()))
    .toBe(ALL_CHANNEL)
}

/** Log `count` info entries through the real logger → main → "All" channel. */
async function streamInfo(page: Page, marker: string, count: number): Promise<void> {
  await page.evaluate(
    ({ marker, count }) => {
      for (let i = 0; i < count; i++) {
        window.__E2E__!.logToChannel('e2eFilter', 'E2E Filter', 'info', `${marker}-${i}`)
      }
    },
    { marker, count },
  )
}

function visibleLines(page: Page, marker: string): Promise<string[]> {
  return page.evaluate(
    (marker) => window.__E2E__!.getVisibleOutputLines().filter((l) => l.includes(marker)),
    marker,
  )
}

/**
 * Assert a marker reaches the All channel and survives the current filter.
 *
 * Arrival is awaited on its own because the write crosses renderer → IPC →
 * main logger → debounced flush → broadcast → aggregation: folding that
 * latency into the visibility poll makes a slow machine look like a filter
 * that swallowed the line. Only the second poll measures the filter. On
 * failure the filter's live state is dumped, which tells "arrived but stayed
 * hidden" (a filter bug) apart from a line that never made it to the channel.
 */
async function expectVisibleInAllChannel(page: Page, marker: string): Promise<void> {
  try {
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ channel, marker }) =>
              window.__E2E__!.getOutputChannelContent(channel).includes(marker),
            { channel: ALL_CHANNEL, marker },
          ),
        { timeout: 15_000 },
      )
      .toBe(true)
    await expect
      .poll(() => visibleLines(page, marker).then((l) => l.length), { timeout: 10_000 })
      .toBeGreaterThan(0)
  } catch (e) {
    const state = await page.evaluate(
      (channel) => ({
        active: window.__E2E__!.getActiveOutputChannelName(),
        hiddenRanges: window.__E2E__!.getOutputHiddenRanges(),
        hiddenLevels: window.__E2E__!.getOutputHiddenLevels(),
        allTail: window.__E2E__!.getOutputChannelContent(channel).split('\n').slice(-6),
        visibleTail: window.__E2E__!.getVisibleOutputLines().slice(-6),
      }),
      ALL_CHANNEL,
    )
    console.log(`[outputLevelFilter] "${marker}" diagnostic:`, JSON.stringify(state))
    throw e
  }
}

test.describe('@p1 output level filter', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      window.__E2E__!.setOutputHiddenLevels([])
      window.__E2E__!.setOutputFilterText('')
    })
  })

  test('hiding levels below Warning hides info lines already in the All channel', async ({
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await showOutputOnAllChannel(page)

    await streamInfo(page, 'e2e-preexisting-info', 40)
    await ensureAllChannelActive(page)
    await expectVisibleInAllChannel(page, 'e2e-preexisting-info')

    await page.evaluate(
      (levels) => window.__E2E__!.setOutputHiddenLevels(levels),
      HIDE_BELOW_WARNING,
    )

    await expect
      .poll(() => visibleLines(page, 'e2e-preexisting-info').then((l) => l.length), {
        timeout: 10_000,
      })
      .toBe(0)
    // Warning survives the same filter — this is a level filter, not a wipe.
    await page.evaluate(() =>
      window.__E2E__!.logToChannel('e2eFilter', 'E2E Filter', 'warn', 'e2e-kept-warning'),
    )
    await ensureAllChannelActive(page)
    await expectVisibleInAllChannel(page, 'e2e-kept-warning')
  })

  test('a channel whose every line is filtered out renders none of them', async ({
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await showOutputOnAllChannel(page)

    // Monaco reveals the whole buffer when asked to hide all of it, so a channel
    // with a single level — an ACP protocol trace is all [info] — used to show
    // everything the moment that level was unchecked.
    const UNIFORM_CHANNEL = 'E2E Uniform'
    await page.evaluate((name) => {
      window.__E2E__!.createOutputChannel(name)
      window.__E2E__!.setActiveOutputChannel(name)
    }, UNIFORM_CHANNEL)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveOutputChannelName()))
      .toBe(UNIFORM_CHANNEL)

    await page.evaluate((name) => {
      let text = ''
      for (let i = 0; i < 30; i++) text += `[info] e2e-uniform-info-${i}\n`
      window.__E2E__!.appendToOutputChannel(name, text)
    }, UNIFORM_CHANNEL)

    await expect
      .poll(() => visibleLines(page, 'e2e-uniform-info').then((l) => l.length), {
        timeout: 15_000,
      })
      .toBe(30)

    await page.evaluate(
      (levels) => window.__E2E__!.setOutputHiddenLevels(levels),
      HIDE_BELOW_WARNING,
    )

    await expect
      .poll(() => visibleLines(page, 'e2e-uniform-info').then((l) => l.length), {
        timeout: 10_000,
      })
      .toBe(0)
  })

  test('a channel written to before it is first shown renders each line once', async ({
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await showOutputOnAllChannel(page)

    // Writing and then showing the channel in one task leaves the append still
    // buffered when the model is seeded, so the pending flush used to append the
    // same delta a second time.
    const PRESEED_CHANNEL = 'E2E Preseed'
    await page.evaluate((name) => {
      window.__E2E__!.createOutputChannel(name)
      let text = ''
      for (let i = 0; i < 10; i++) text += `[info] e2e-preseed-${i}\n`
      window.__E2E__!.appendToOutputChannel(name, text)
      window.__E2E__!.setActiveOutputChannel(name)
    }, PRESEED_CHANNEL)

    await expect
      .poll(() => visibleLines(page, 'e2e-preseed-').then((l) => l.length), {
        timeout: 15_000,
      })
      .toBe(10)
    // The model must stay identical to the channel's own text.
    expect(
      await page.evaluate(
        (name) => window.__E2E__!.getOutputChannelContent(name).trimEnd().split('\n').length,
        PRESEED_CHANNEL,
      ),
    ).toBe(10)
  })

  test('a level toggle takes effect while the channel is still streaming', async ({
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await showOutputOnAllChannel(page)

    // A channel that keeps flushing faster than the 150ms filter window, the way
    // an ACP session's protocol trace does. Driven in-renderer so the flush
    // cadence is the channel's own, not the main-process log writer's.
    const STREAM_CHANNEL = 'E2E Stream'
    await page.evaluate((name) => {
      window.__E2E__!.createOutputChannel(name)
      window.__E2E__!.setActiveOutputChannel(name)
    }, STREAM_CHANNEL)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveOutputChannelName()))
      .toBe(STREAM_CHANNEL)

    await page.evaluate((name) => {
      const w = window as unknown as { __e2eLogTimer__?: ReturnType<typeof setInterval> }
      let n = 0
      w.__e2eLogTimer__ = setInterval(() => {
        window.__E2E__!.appendToOutputChannel(name, `[info] e2e-streaming-info-${n++}\n`)
      }, 50)
    }, STREAM_CHANNEL)

    await expect
      .poll(() => visibleLines(page, 'e2e-streaming-info').then((l) => l.length), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0)

    await page.evaluate(
      (levels) => window.__E2E__!.setOutputHiddenLevels(levels),
      HIDE_BELOW_WARNING,
    )

    try {
      // The filter must keep up with the stream: only lines that arrived inside
      // the current refresh window may still show. A refresh that every incoming
      // flush postpones leaves the whole backlog visible instead.
      await expect
        .poll(() => visibleLines(page, 'e2e-streaming-info').then((l) => l.length), {
          timeout: 5_000,
        })
        .toBeLessThan(10)
    } finally {
      await page.evaluate(() => {
        const w = window as unknown as { __e2eLogTimer__?: ReturnType<typeof setInterval> }
        if (w.__e2eLogTimer__) clearInterval(w.__e2eLogTimer__)
        delete w.__e2eLogTimer__
      })
    }

    // Once the stream stops, the backlog must be fully hidden.
    await expect
      .poll(() => visibleLines(page, 'e2e-streaming-info').then((l) => l.length), {
        timeout: 10_000,
      })
      .toBe(0)
  })
})
