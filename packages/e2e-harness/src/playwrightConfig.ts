/*---------------------------------------------------------------------------------------------
 *  Shared Playwright config factory for the core + per-extension e2e suites.
 *
 *  Every suite ran a near-verbatim copy of the same config (timeout / retries /
 *  workers / reporter / trace-on-failure), differing only in `testDir` and — for
 *  the core suite — a `snapshotDir` + screenshot-animation option for its visual
 *  specs. Copies drift: a CI-timeout tweak had to be applied in N places. This
 *  factory owns the shared cross-cutting knobs; callers pass only what differs.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'
import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'

const isCI = Boolean(process.env['CI'])

// Local worker count scales with the machine: each worker drives its own
// Electron instance (shared-app fixture), so oversubscribing cores only
// thrashes cold starts. Measured on a 16-core box: the full core main pass
// dropped 222s → 114s going 4 → 8 workers. Cap at 8 — beyond that, concurrent
// Electron cold launches starve each other and timing-sensitive specs flake.
const localWorkers = Math.max(4, Math.min(8, Math.floor(cpus().length / 2)))

// Tag-filtering policy — the SINGLE SOURCE OF TRUTH shared by the core + every
// extension config + CI, so filtering behaves identically everywhere. The whole
// policy lives here; callers pass NO --grep/--grep-invert flags, they only set the
// env seams below. (Extensions previously ran a bare `playwright test` and so
// executed their @regression cases on every run — the inconsistency this fixes.)
//
// Tags and where they run:
//   @visual  — visual baselines; only the dedicated pass (ONLY_TAG=@visual)
//   @flaky   — environment-sensitive; only its own report-only pass
//   @perf    — startup-timeline observation; only its own pass
//   @serial  — cross-process races; excluded from the parallel pass, run by a
//              separate --workers=1 pass (ONLY_TAG=@serial)
//   @regression — bug-guard; excluded from the default pass, folded into `e2ea`
//                 (INCLUDE_REGRESSION=1); CI runs it as its own pass (ONLY_TAG=@regression)
//   @p0      — core smoke; `e2e:smoke` runs ONLY_TAG=@p0 with
//              ONLY_TAG_INVERT=@serial|@flaky|@perf|@visual so a case double-tagged
//              @p0+@serial cannot leak into the parallel smoke pass
const NEVER_TAGS = ['@visual', '@flaky', '@perf'] as const

// e2ea: fold @regression back into the main pass (@visual/@flaky/@perf stay out,
// @serial stays its own pass).
const INCLUDE_REGRESSION = process.env['UNIVERSE_E2E_INCLUDE_REGRESSION'] === '1'
// A dedicated single-tag pass: run ONLY specs carrying this tag, ignoring the
// default exclusions. Used by the @serial (--workers=1) pass and by CI's separate
// @regression / @flaky / @perf / @visual passes. Empty ⇒ the normal main pass.
const ONLY_TAG = process.env['UNIVERSE_E2E_ONLY_TAG']
// Exclusions applied ON TOP of an ONLY_TAG pass. The value is a regex alternation
// (deliberately NOT escaped, unlike ONLY_TAG's literal single tag): e2e:smoke sets
// `@serial|@flaky|@perf|@visual` so those hazard tags stay in their dedicated passes.
const ONLY_TAG_INVERT = process.env['UNIVERSE_E2E_ONLY_TAG_INVERT']
// Debug escape hatch (the `e2eg` script): drop the default exclusions entirely so a
// hand-passed `--grep <title>` can select ANY spec, including ones tagged
// @regression / @serial / @flaky / @perf / @visual — otherwise the default
// grepInvert intersects the CLI --grep and silently yields "No tests found".
const NO_TAG_FILTER = process.env['UNIVERSE_E2E_NO_TAG_FILTER'] === '1'

/** grep / grepInvert for the current pass, derived entirely from the env seams. */
function grepOptions(): { grep?: RegExp; grepInvert?: RegExp } {
  if (NO_TAG_FILTER) {
    return {}
  }
  if (ONLY_TAG) {
    // Match the tag literally (@ is not a regex metachar; escape defensively).
    return {
      grep: new RegExp(ONLY_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      ...(ONLY_TAG_INVERT ? { grepInvert: new RegExp(ONLY_TAG_INVERT) } : {}),
    }
  }
  const excluded = [...NEVER_TAGS, '@serial', ...(INCLUDE_REGRESSION ? [] : ['@regression'])]
  return { grepInvert: new RegExp(excluded.join('|')) }
}

export interface E2EConfigOptions {
  /** Test directory, relative to the config file. Defaults to './specs'. */
  readonly testDir?: string
  /** Visual-baseline dir (only the core suite has @visual specs). */
  readonly snapshotDir?: string
  /**
   * Disable animations for `toHaveScreenshot` (visual suites only). Off by default
   * so extension configs don't carry a screenshot option they never use.
   */
  readonly disableScreenshotAnimations?: boolean
  /**
   * Test-level (instead of file-level) scheduling. Off by default: the extension
   * suites cold-launch one Electron per TEST, so spreading a file's tests across
   * all workers stacks concurrent cold starts and starves extension-host
   * activation (measured: perforce swarm specs, 12 tests × 8 workers, dashboard
   * loads blowing the expect timeout). The core suite opts in — its shared-app
   * fixture keeps one Electron per WORKER, so within-file parallelism is cheap
   * and removes the end-of-pass tail where one worker grinds through the last
   * big spec file alone.
   */
  readonly fullyParallel?: boolean
}

/**
 * Build the Playwright config every e2e suite shares. CI vs local knobs:
 *   - expect timeout: 10s on CI (contended cold starts — Monaco/LSP warmup), 5s local
 *   - retries: 1 — CI covers runner contention; local covers the occasional
 *     timing flake that higher worker counts surface (a rerun is far cheaper
 *     than a human re-running the suite)
 *   - workers: 2 on CI (2-core runners starve at 4), core-scaled locally (≤8)
 *   - reporter: github + html on CI, list locally
 * Retain-on-failure trace/video/screenshot are constant; `fullyParallel` is an
 * opt-in (see E2EConfigOptions.fullyParallel for the shared-app vs cold-launch
 * rationale).
 *
 * Tag filtering (grep/grepInvert) is derived from UNIVERSE_E2E_INCLUDE_REGRESSION
 * and UNIVERSE_E2E_SERIAL_ONLY — see grepOptions(). Scripts set those envs and pass
 * no --grep flags.
 */
export function defineE2EConfig(options: E2EConfigOptions = {}): PlaywrightTestConfig {
  const { grep, grepInvert } = grepOptions()
  return defineConfig({
    // Unconditional: the setup itself no-ops unless linux && no DISPLAY, so the
    // core + every extension suite get headless Xvfb bootstrap for free. The .js
    // suffix is the ESM convention for the compiled sibling in dist/.
    globalSetup: fileURLToPath(new URL('./globalSetup.js', import.meta.url)),
    testDir: options.testDir ?? './specs',
    ...(options.snapshotDir !== undefined ? { snapshotDir: options.snapshotDir } : {}),
    ...(grep !== undefined ? { grep } : {}),
    ...(grepInvert !== undefined ? { grepInvert } : {}),
    timeout: 30_000,
    expect: {
      timeout: isCI ? 10_000 : 5_000,
      ...(options.disableScreenshotAnimations
        ? { toHaveScreenshot: { animations: 'disabled' as const } }
        : {}),
    },
    retries: 1,
    workers: isCI ? 2 : localWorkers,
    // A fullyParallel suite must keep its specs order-independent (per-test
    // mkdtemp workspaces, fixtures reload/reset between tests); a file that DOES
    // share module-level resources across its tests opts out via
    // test.describe.configure({mode:'default'}) (see smoke.update.spec.ts —
    // fixed feed port + shared dev-app-update.yml).
    fullyParallel: options.fullyParallel ?? false,
    reporter: isCI
      ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
      : [['list']],
    use: {
      trace: 'retain-on-failure',
      video: 'retain-on-failure',
      screenshot: 'only-on-failure',
    },
    outputDir: 'test-results',
  })
}
