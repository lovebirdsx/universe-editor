// One-off measurement script (not part of the repo's permanent tooling) used to
// validate docs/plan/startup-defer-parcel-watch-plan.md. Launches the built app
// with this repo as the startup workspace and reads window.__E2E__.getStartupMetrics().
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const APP_ROOT = resolve(import.meta.dirname, '..')
const MAIN_ENTRY = resolve(APP_ROOT, 'out', 'main', 'index.js')
const REPO_ROOT = resolve(APP_ROOT, '..', '..')
const RUNS = Number(process.argv[2] ?? 3)

async function runOnce() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-perf-'))
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
  const app = await electron.launch({
    args: [MAIN_ENTRY, REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: { ...inheritedEnv, UNIVERSE_E2E: '1', NODE_ENV: inheritedEnv.NODE_ENV ?? 'production' },
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.__E2E__))
    await page.evaluate(() => window.__E2E__.whenRestored())
    // Give the Eventually-phase idle callback (WorkspaceWatchContribution) a
    // chance to fire before reading metrics, so the watch marks are captured.
    await page.waitForTimeout(1000)
    const metrics = await page.evaluate(() => window.__E2E__.getStartupMetrics())
    return metrics
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

const results = []
for (let i = 0; i < RUNS; i++) {
  const m = await runOnce()
  results.push(m)
  const order = m.phases.map((p) => p.to)
  const watchIdx = order.indexOf('Workspace watch start')
  const mountIdx = order.indexOf('Workbench mounted')
  console.log(
    `run ${i + 1}: total=${m.totalTime.toFixed(1)}ms watchAfterMount=${watchIdx === -1 ? 'n/a(no watch phase)' : mountIdx === -1 ? 'n/a(no mount phase)' : watchIdx > mountIdx}`,
  )
  console.log('  order:', order.join(' -> '))
  console.log('  phases:', m.phases.map((p) => `${p.label}=${p.duration.toFixed(1)}ms`).join(', '))
}

const avgTotal = results.reduce((s, r) => s + r.totalTime, 0) / results.length
console.log(`\naverage totalTime = ${avgTotal.toFixed(1)}ms over ${RUNS} runs`)
