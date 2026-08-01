/*---------------------------------------------------------------------------------------------
 *  Interaction performance collection against a REAL workspace folder (@perf).
 *
 *  Same tour shape as smoke.interactionPerfReport.spec.ts, but the workspace is
 *  a user-picked folder passed via env instead of a seeded tmp dir — for
 *  reproducing jank that only shows up at a real project's scale (watcher /
 *  file index / search breadth), and for capturing a field report from a
 *  folder where a user actually feels lag.
 *
 *  Driven by env (both read at module load):
 *    UNIVERSE_PERF_WORKSPACE      absolute folder path, launched as the
 *                                 positional argv (same openWindowForFolder
 *                                 path as workspaceSeeder — extension host
 *                                 stays single-generation). Required; the test
 *                                 skips without it (CI @perf run is a no-op).
 *    UNIVERSE_PERF_THRESHOLD_MS   optional slow-interaction threshold override
 *                                 (Memory target, live-applied). Default: the
 *                                 app's own default (200ms). Deep-collect runs
 *                                 pass e.g. 50 to capture attribution for the
 *                                 top ~20 interactions.
 *
 *  Safety on the real folder: writes land ONLY on two probe files created at
 *  the workspace root (`.universe-perf-probe*.ts`) and removed in a finally —
 *  typing / undo / save scenarios target the probe files; real files are
 *  opened read-only (quick open) or just searched.
 *
 *  Artifacts: test-results/interaction-perf-collect.{json,md} (distinct name
 *  so it never clobbers the seeded-tour report). See the
 *  analyze-interaction-performance skill for the read-the-report playbook.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createColdAppTest, expect } from '@universe-editor/e2e-harness'
import type { E2EInteractionPerfSummary } from '../../src/shared/e2e/contract.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, '..', '..')
const MAIN_ENTRY = resolve(APP_ROOT, 'out', 'main', 'index.js')
const RESULTS_DIR = join(__dirname, '..', 'test-results')
const JSON_ARTIFACT = join(RESULTS_DIR, 'interaction-perf-collect.json')
const MD_ARTIFACT = join(RESULTS_DIR, 'interaction-perf-collect.md')

const WORKSPACE = process.env['UNIVERSE_PERF_WORKSPACE']
const THRESHOLD_MS = process.env['UNIVERSE_PERF_THRESHOLD_MS']

// No workspaceSeeder: the folder itself is the positional launch arg.
const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: [],
  extraArgs: [...(WORKSPACE ? [realpathSync.native(WORKSPACE)] : [])],
})

const PROBE_FILE = '.universe-perf-probe.ts'
const PROBE_LARGE = '.universe-perf-probe-large.ts'

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
  workspace: string,
): string {
  const lines: string[] = []
  lines.push('# Interaction Performance Report (real workspace)')
  lines.push('')
  lines.push(`Generated: ${generatedAt}`)
  lines.push(`Workspace: ${workspace}`)
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

/** Pick a real file from the workspace for the read-only quick-open leg.
 *  Shallow scan (root + one level), skipping the usual noise dirs. */
function pickRealFile(workspaceDir: string): string | undefined {
  const SKIP = new Set(['.git', 'node_modules', 'dist', 'out', PROBE_FILE, PROBE_LARGE])
  const EXTS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.md',
    '.json',
    '.css',
    '.py',
    '.rs',
    '.go',
    '.java',
  ])
  const candidates: string[] = []
  const scan = (dir: string, depth: number): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.git') || SKIP.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth > 0) scan(full, depth - 1)
      } else if (EXTS.has(e.name.slice(e.name.lastIndexOf('.')))) {
        candidates.push(e.name)
        if (candidates.length >= 4) return
      }
    }
  }
  scan(workspaceDir, 1)
  // Prefer a name whose basename is specific enough for quick-open filtering.
  return candidates.find((n) => n.length > 5) ?? candidates[0]
}

test.describe('@perf interaction perf collect (real workspace)', () => {
  test.skip(!WORKSPACE, 'UNIVERSE_PERF_WORKSPACE not set — nothing to collect against')

  test('drives the editing tour against a user-picked folder', async ({
    page,
    workbench,
  }, testInfo) => {
    test.slow()
    if (!WORKSPACE) return
    const workspaceDir = realpathSync.native(WORKSPACE)
    if (!existsSync(workspaceDir)) throw new Error(`workspace not found: ${workspaceDir}`)

    // Probe files at the workspace ROOT (top-level treeitems stay visible in
    // Explorer without expanding a folder, and cleanup is two unlinks).
    const probePath = join(workspaceDir, PROBE_FILE)
    const probeLargePath = join(workspaceDir, PROBE_LARGE)
    writeFileSync(
      probePath,
      Array.from({ length: 50 }, (_, i) => `export const perfProbeV${i} = ${i}`).join('\n'),
      'utf8',
    )
    writeFileSync(
      probeLargePath,
      Array.from(
        { length: 5000 },
        (_, i) => `export function perfProbeFn${i}(x: number): number { return x + ${i} }`,
      ).join('\n'),
      'utf8',
    )

    try {
      await workbench.waitForRestored()
      if (THRESHOLD_MS) {
        await page.evaluate(
          (t) => window.__E2E__!.updateConfigValue('performance.responsiveness.warnThresholdMs', t),
          Number(THRESHOLD_MS),
        )
      }

      const perfNow = (): Promise<number> => page.evaluate(() => performance.now())
      const scenarios: ScenarioWindow[] = []
      const runScenario = async (name: string, fn: () => Promise<void>): Promise<void> => {
        const startMs = await perfNow()
        await fn()
        scenarios.push({ name, startMs, endMs: await perfNow() })
      }

      const posixWs = workspaceDir.replace(/\\/g, '/')
      const activeUri = () => page.evaluate(() => window.__E2E__!.getActiveEditorUri())
      const focusEditor = () => page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))

      // Warmup outside any scenario: mount the first editor on the probe file.
      await page.evaluate(
        (fsPath) => window.__E2E__!.openFileUri(fsPath),
        `${posixWs}/${PROBE_FILE}`,
      )
      await expect.poll(activeUri).toContain(PROBE_FILE)
      await focusEditor()

      const openViaQuickOpen = async (fileName: string): Promise<void> => {
        await page.keyboard.press('Control+p')
        await workbench.quickInput.waitForVisible()
        await page.keyboard.type(fileName)
        // Real workspaces filter over a larger index; give the list more time
        // than the seeded tour before committing.
        await page.waitForTimeout(800)
        await page.keyboard.press('Enter')
        // Case-insensitive: a real folder can hold same-name files differing
        // only by case (development/claude.md vs user/CLAUDE.md) and the
        // case-insensitive quick-open match may open the other one.
        await expect
          .poll(async () => (await activeUri())?.toLowerCase(), { timeout: 15_000 })
          .toContain(fileName.toLowerCase())
      }

      const realFile = pickRealFile(workspaceDir)

      await runScenario('quick-open-files', async () => {
        if (realFile && realFile !== PROBE_FILE) await openViaQuickOpen(realFile)
        await openViaQuickOpen(PROBE_LARGE)
      })

      await runScenario('typing', async () => {
        await openViaQuickOpen(PROBE_FILE)
        await focusEditor()
        await page.keyboard.type('\nconst perfProbeAnswer = 42\n// a line of commentary\n', {
          delay: 20,
        })
      })

      await runScenario('cursor-navigation', async () => {
        await focusEditor()
        for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown')
        for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
        await page.keyboard.press('Control+End')
        await page.keyboard.press('Control+Home')
      })

      await runScenario('scroll-large-file', async () => {
        await openViaQuickOpen(PROBE_LARGE)
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
        await openViaQuickOpen(PROBE_FILE)
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
        // Unique probe token: deterministic hit count (only the large probe
        // file) so the results render load is stable across folders.
        await page.keyboard.type('perfProbeFn1', { delay: 20 })
        await page.keyboard.press('Enter')
        await page.waitForTimeout(1500)
        await page.keyboard.press('Escape')
      })

      await runScenario('explorer-click', async () => {
        await page.keyboard.press('Control+Shift+e')
        const probeItem = page.locator('[role="treeitem"]', { hasText: PROBE_FILE })
        await probeItem.waitFor({ state: 'visible' })
        await probeItem.click()
        await expect.poll(activeUri).toContain(PROBE_FILE)
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

      expect(summary.interactionCount).toBeGreaterThan(0)
      expect(Object.keys(summary.byType).some((t) => t.startsWith('key'))).toBe(true)

      const generatedAt = new Date().toISOString()
      const payload = { generatedAt, workspace: workspaceDir, scenarios, summary }
      const markdown = buildMarkdown(summary, scenarios, generatedAt, workspaceDir)

      mkdirSync(RESULTS_DIR, { recursive: true })
      writeFileSync(JSON_ARTIFACT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      writeFileSync(MD_ARTIFACT, markdown, 'utf8')
      await testInfo.attach('interaction-perf-collect', {
        body: JSON.stringify(payload, null, 2),
        contentType: 'application/json',
      })
      await testInfo.attach('interaction-perf-collect-md', {
        body: markdown,
        contentType: 'text/markdown',
      })

      console.log(
        `[perf] workspace=${workspaceDir} interactions=${summary.interactionCount} ` +
          `slow=${summary.slowCount} loaf=${summary.loafCount} — report: ${MD_ARTIFACT}`,
      )
    } finally {
      rmSync(probePath, { force: true })
      rmSync(probeLargePath, { force: true })
    }
  })
})
