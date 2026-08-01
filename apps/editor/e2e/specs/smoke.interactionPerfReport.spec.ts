/*---------------------------------------------------------------------------------------------
 *  Interaction performance report (@perf, observe-only).
 *
 *  Drives the workbench through a scripted tour of everyday editing gestures —
 *  quick open, typing, cursor travel, large-file scrolling, tab switching,
 *  undo/redo, command palette, search, explorer clicks, save — all with REAL
 *  trusted key/mouse input so the Event Timing floor samples them as genuine
 *  user interactions. Then it pulls the InteractionPerfService session summary
 *  (per-type histograms + slowest interactions with input/processing/present
 *  decomposition and phase/LoAF attribution), buckets each slow interaction
 *  into the scenario window that produced it (same performance.now() timebase),
 *  and writes JSON + Markdown artifacts an agent can read to localize jank.
 *
 *  Never asserts a latency budget — interaction timing on shared CI runners is
 *  too noisy for a hard gate. See smoke.startupPerformance.spec.ts for the
 *  startup-side counterpart.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import type { E2EInteractionPerfSummary } from '../../src/shared/e2e/contract.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = join(__dirname, '..', 'test-results')
const JSON_ARTIFACT = join(RESULTS_DIR, 'interaction-perf-report.json')
const MD_ARTIFACT = join(RESULTS_DIR, 'interaction-perf-report.md')

interface ScenarioWindow {
  readonly name: string
  readonly startMs: number
  readonly endMs: number
}

type Summary = E2EInteractionPerfSummary
type SlowEntry = Summary['slowest'][number]

const ms = (n: number): string => `${Math.round(n)}ms`

function formatAttribution(entry: SlowEntry): string {
  const parts: string[] = []
  for (const p of entry.phases) {
    parts.push(`phase ${p.name} ${ms(p.duration)} @+${ms(p.startTime - entry.startTime)}`)
  }
  for (const loaf of entry.loafs) {
    const scripts =
      loaf.scripts.length > 0
        ? loaf.scripts
            .map(
              (s) =>
                `${s.sourceUrl || '<anonymous>'}${s.sourceFunctionName ? `#${s.sourceFunctionName}` : ''} (${s.invoker}) ${ms(s.durationMs)}`,
            )
            .join('; ')
        : '<no script attribution>'
    parts.push(`frame ${ms(loaf.duration)} blocking ${ms(loaf.blockingDuration)}: ${scripts}`)
  }
  return parts.join(' | ')
}

function buildMarkdown(
  summary: Summary,
  scenarios: readonly ScenarioWindow[],
  generatedAt: string,
): string {
  const lines: string[] = []
  lines.push('# Interaction Performance Report')
  lines.push('')
  lines.push(`Generated: ${generatedAt}`)
  lines.push(
    `Interactions sampled: ${summary.interactionCount} (${summary.totalSampleCount} samples ≥16ms) · ` +
      `Slow: ${summary.slowCount} · Long frames: ${summary.loafCount}`,
  )
  lines.push('')

  lines.push('## By interaction type')
  lines.push('')
  const types = Object.entries(summary.byType).sort((a, b) => b[1].count - a[1].count)
  if (types.length === 0) {
    lines.push('_No interactions sampled._')
  } else {
    lines.push('| type | count | p95 | p99 | max |')
    lines.push('| --- | ---: | ---: | ---: | ---: |')
    for (const [type, stats] of types) {
      lines.push(
        `| ${type} | ${stats.count} | ${ms(stats.p95Ms)} | ${ms(stats.p99Ms)} | ${ms(stats.maxMs)} |`,
      )
    }
  }
  lines.push('')

  lines.push('## Scenario windows')
  lines.push('')
  lines.push('| scenario | start | end |')
  lines.push('| --- | ---: | ---: |')
  for (const s of scenarios) {
    lines.push(`| ${s.name} | ${ms(s.startMs)} | ${ms(s.endMs)} |`)
  }
  lines.push('')

  lines.push('## Slow interactions by scenario')
  lines.push('')
  const bucketed = new Set<SlowEntry>()
  for (const scenario of scenarios) {
    const entries = summary.slowest.filter(
      (e) => e.startTime >= scenario.startMs && e.startTime <= scenario.endMs,
    )
    for (const e of entries) bucketed.add(e)
    lines.push(`### ${scenario.name}`)
    lines.push('')
    if (entries.length === 0) {
      lines.push('_No slow interactions in this window._')
    }
    for (const entry of entries) {
      const d = entry.decomposition
      lines.push(
        `- **${entry.label} ${ms(entry.durationMs)}** ` +
          `(input ${ms(d.inputDelayMs)} / processing ${ms(d.processingMs)} / present ${ms(d.presentationDelayMs)})` +
          ` target=${entry.context.target}${entry.context.editor ? ` editor=${entry.context.editor}` : ''}`,
      )
      const attribution = formatAttribution(entry)
      if (attribution) lines.push(`  - ${attribution}`)
    }
    lines.push('')
  }

  const outside = summary.slowest.filter((e) => !bucketed.has(e))
  if (outside.length > 0) {
    lines.push('### Outside scenario windows (startup / warmup / between scenarios)')
    lines.push('')
    for (const entry of outside) {
      const d = entry.decomposition
      lines.push(
        `- **${entry.label} ${ms(entry.durationMs)}** @${ms(entry.startTime)} ` +
          `(input ${ms(d.inputDelayMs)} / processing ${ms(d.processingMs)} / present ${ms(d.presentationDelayMs)})` +
          ` target=${entry.context.target}${entry.context.editor ? ` editor=${entry.context.editor}` : ''}`,
      )
      const attribution = formatAttribution(entry)
      if (attribution) lines.push(`  - ${attribution}`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

test.describe('@perf interaction performance report', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
          writeFileSync(
            join(dir, `${name}.ts`),
            Array.from({ length: 50 }, (_, i) => `export const v${i} = ${i}`).join('\n'),
          )
        }
        writeFileSync(
          join(dir, 'large.ts'),
          Array.from(
            { length: 5000 },
            (_, i) => `export function fn${i}(x: number): number { return x + ${i} }`,
          ).join('\n'),
        )
        writeFileSync(join(dir, 'notes.md'), '# Notes\n\n- alpha\n- beta\n')
      },
    },
  })

  test('drives an editing tour and records the responsiveness report', async ({
    page,
    workbench,
    launchWorkspace,
  }, testInfo) => {
    test.slow()
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
    await workbench.waitForRestored()

    const perfNow = (): Promise<number> => page.evaluate(() => performance.now())
    const scenarios: ScenarioWindow[] = []
    const runScenario = async (name: string, fn: () => Promise<void>): Promise<void> => {
      const startMs = await perfNow()
      await fn()
      scenarios.push({ name, startMs, endMs: await perfNow() })
    }

    const activeUri = () => page.evaluate(() => window.__E2E__!.getActiveEditorUri())
    const focusEditor = () => page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))

    // Warmup outside any scenario: mount the first editor and focus it, so the
    // tour measures steady-state gestures instead of Monaco's first-mount cost.
    await page.evaluate(
      (fsPath) => window.__E2E__!.openFileUri(fsPath),
      launchWorkspace.file('alpha.ts'),
    )
    await expect.poll(activeUri).toContain('alpha.ts')
    await focusEditor()

    const openViaQuickOpen = async (fileName: string): Promise<void> => {
      await page.keyboard.press('Control+p')
      await workbench.quickInput.waitForVisible()
      await page.keyboard.type(fileName)
      // The file provider filters over IPC; give the list a beat before Enter.
      await page.waitForTimeout(500)
      await page.keyboard.press('Enter')
      await expect.poll(activeUri, { timeout: 10_000 }).toContain(fileName)
    }

    await runScenario('quick-open-files', async () => {
      await openViaQuickOpen('beta.ts')
      await openViaQuickOpen('notes.md')
    })

    await runScenario('typing', async () => {
      await focusEditor()
      await page.keyboard.type('\nconst answer = 42\n// a line of commentary\n', { delay: 20 })
    })

    await runScenario('cursor-navigation', async () => {
      await focusEditor()
      for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown')
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Control+End')
      await page.keyboard.press('Control+Home')
    })

    await runScenario('scroll-large-file', async () => {
      await openViaQuickOpen('large.ts')
      await focusEditor()
      for (let i = 0; i < 8; i++) await page.keyboard.press('PageDown')
      await page.keyboard.press('Control+End')
      await page.keyboard.press('Control+Home')
    })

    await runScenario('tab-switch', async () => {
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Control+PageDown')
        await page.waitForTimeout(200)
      }
    })

    await runScenario('edit-undo-redo', async () => {
      await focusEditor()
      await page.keyboard.type('x')
      await page.keyboard.press('Control+z')
      await page.keyboard.press('Control+y')
    })

    await runScenario('command-palette', async () => {
      await page.keyboard.press('F1')
      await workbench.quickInput.waitForVisible()
      await page.keyboard.type('interaction')
      await page.waitForTimeout(300)
      await page.keyboard.press('Escape')
      await workbench.quickInput.waitForHidden()
    })

    await runScenario('search-view', async () => {
      await page.keyboard.press('Control+Shift+f')
      await page.waitForTimeout(300)
      await page.keyboard.type('fn1', { delay: 20 })
      await page.keyboard.press('Enter')
      // Let the results stream in and render — that render is the interaction
      // load this scenario measures.
      await page.waitForTimeout(1500)
      await page.keyboard.press('Escape')
    })

    await runScenario('explorer-click', async () => {
      // The search-view scenario swapped the sidebar to Search; bring Explorer
      // back so its tree is rendered and clickable.
      await page.keyboard.press('Control+Shift+e')
      const alpha = page.locator('[role="treeitem"]', { hasText: 'alpha.ts' })
      await alpha.waitFor({ state: 'visible' })
      await alpha.click()
      await expect.poll(activeUri).toContain('alpha.ts')
      await page.locator('[role="treeitem"]', { hasText: 'delta.ts' }).click()
      await expect.poll(activeUri).toContain('delta.ts')
    })

    await runScenario('save-file', async () => {
      await focusEditor()
      await page.keyboard.type('y')
      await page.keyboard.press('Control+s')
      await page.waitForTimeout(300)
    })

    // Let the observers flush their last entries before reading the summary.
    await page.waitForTimeout(1000)
    const summary = await page.evaluate(() => window.__E2E__!.getInteractionPerfSummary())

    // Sanity (not a budget): the tour must have been sampled, and keyboard
    // gestures must carry their real event names.
    expect(summary.interactionCount).toBeGreaterThan(0)
    expect(Object.keys(summary.byType).some((t) => t.startsWith('key'))).toBe(true)

    const generatedAt = new Date().toISOString()
    const payload = { generatedAt, scenarios, summary }
    const markdown = buildMarkdown(summary, scenarios, generatedAt)

    mkdirSync(RESULTS_DIR, { recursive: true })
    writeFileSync(JSON_ARTIFACT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    writeFileSync(MD_ARTIFACT, markdown, 'utf8')
    await testInfo.attach('interaction-perf-report', {
      body: JSON.stringify(payload, null, 2),
      contentType: 'application/json',
    })
    await testInfo.attach('interaction-perf-report-md', {
      body: markdown,
      contentType: 'text/markdown',
    })

    console.log(
      `[perf] interactions=${summary.interactionCount} slow=${summary.slowCount} ` +
        `loaf=${summary.loafCount} — report: ${MD_ARTIFACT}`,
    )
  })
})
