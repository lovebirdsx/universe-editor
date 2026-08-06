/*---------------------------------------------------------------------------------------------
 *  Diagnostic spec (@perf, env-gated): tab-switch jank profiling on a real workspace.
 *
 *  Opens two real files (env-driven), warms up, then clicks between their tabs
 *  with a CDP profiler attached; big IPC frames (>128KB) hitting the renderer
 *  decoder are logged per switch window. Skipped unless all three env vars are set:
 *    UNIVERSE_PERF_WORKSPACE=<dir> UNIVERSE_PERF_FILE_A=<file> UNIVERSE_PERF_FILE_B=<file> \
 *      pnpm --filter @universe-editor/editor e2eg "profiles tab switching"
 *  Artifacts:
 *    test-results/tab-switch-profile.cpuprofile   V8 profile of the switch loop
 *    test-results/tab-switch-profile.json         interaction perf summary + switch windows + big frames
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createColdAppTest, expect } from '@universe-editor/e2e-harness'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, '..', '..')
const MAIN_ENTRY = resolve(APP_ROOT, 'out', 'main', 'index.js')
const RESULTS_DIR = join(__dirname, '..', 'test-results')

const WORKSPACE = process.env['UNIVERSE_PERF_WORKSPACE']
const FILE_A = process.env['UNIVERSE_PERF_FILE_A']
const FILE_B = process.env['UNIVERSE_PERF_FILE_B']

const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: ['@universe-editor/typescript'],
  extraArgs: [...(WORKSPACE ? [realpathSync.native(WORKSPACE)] : [])],
})

test.describe('@perf tab switch profile (real workspace)', () => {
  test.skip(!WORKSPACE || !FILE_A || !FILE_B, 'UNIVERSE_PERF_WORKSPACE/FILE_A/FILE_B not set')

  test('profiles tab switching between two large files', async ({ page, workbench }) => {
    test.slow()
    if (!WORKSPACE || !FILE_A || !FILE_B) return
    if (!existsSync(FILE_A) || !existsSync(FILE_B)) throw new Error('target files not found')

    await workbench.waitForRestored()
    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('performance.responsiveness.warnThresholdMs', 50),
    )

    // Log every big decoded frame (method + size) so per-message payload cost is
    // attributable without rebuilding the app.
    const bigFrames: { atMs: number; length: number; head: string }[] = []
    page.on('console', (msg) => {
      const text = msg.text()
      if (!text.startsWith('[BIGFRAME]')) return
      const m = text.match(/^\[BIGFRAME\] (\d+) (\d+) ([\s\S]*)$/)
      if (m) bigFrames.push({ atMs: Number(m[1]), length: Number(m[2]), head: m[3]!.slice(0, 220) })
    })
    await page.evaluate(() => {
      const orig = TextDecoder.prototype.decode
      TextDecoder.prototype.decode = function (...args: Parameters<typeof orig>) {
        const r = orig.apply(this, args)
        if (typeof r === 'string' && r.length > 131072) {
          console.log(`[BIGFRAME] ${Math.round(performance.now())} ${r.length} ${r.slice(0, 220)}`)
        }
        return r
      }
    })

    const activeUri = () => page.evaluate(() => window.__E2E__!.getActiveEditorUri())
    const posix = (p: string) => p.replace(/\\/g, '/')

    // Open both files, pinned, and let tokenization / tsserver warm up.
    await page.evaluate((p) => window.__E2E__!.openFileUri(p, { pinned: true }), posix(FILE_A))
    await expect.poll(activeUri, { timeout: 30_000 }).toContain(basename(FILE_A))
    await page.waitForTimeout(3000)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p, { pinned: true }), posix(FILE_B))
    await expect.poll(activeUri, { timeout: 30_000 }).toContain(basename(FILE_B))
    await page.waitForTimeout(8000)

    const tabA = page.locator('[role="tab"]', { hasText: basename(FILE_A) }).first()
    const tabB = page.locator('[role="tab"]', { hasText: basename(FILE_B) }).first()

    const session = await page.context().newCDPSession(page)
    await session.send('Profiler.enable')
    await session.send('Profiler.setSamplingInterval', { interval: 100 })
    await session.send('Profiler.start')

    const switches: { label: string; startMs: number; endMs: number }[] = []
    const perfNow = (): Promise<number> => page.evaluate(() => performance.now())
    for (let i = 0; i < 4; i++) {
      for (const [tab, name] of [
        [tabA, basename(FILE_A)],
        [tabB, basename(FILE_B)],
      ] as const) {
        const startMs = await perfNow()
        await tab.click()
        await expect.poll(activeUri).toContain(name)
        await page.waitForTimeout(1800)
        switches.push({ label: `switch->${name} #${i}`, startMs, endMs: await perfNow() })
      }
    }

    const { profile } = await session.send('Profiler.stop')
    await page.waitForTimeout(500)
    const summary = await page.evaluate(() => window.__E2E__!.getInteractionPerfSummary())

    mkdirSync(RESULTS_DIR, { recursive: true })
    writeFileSync(
      join(RESULTS_DIR, 'tab-switch-profile.cpuprofile'),
      JSON.stringify(profile),
      'utf8',
    )
    writeFileSync(
      join(RESULTS_DIR, 'tab-switch-profile.json'),
      JSON.stringify({ switches, bigFrames, summary }, null, 2),
      'utf8',
    )
    console.log(`[perf] profile written: ${join(RESULTS_DIR, 'tab-switch-profile.cpuprofile')}`)
  })
})
