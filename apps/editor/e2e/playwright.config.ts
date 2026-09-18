import { defineE2EConfig, type E2EConfigOptions } from '@universe-editor/e2e-harness'

// Core suite knobs. Shared knobs (timeout / retries / workers / reporter /
// trace-on-failure) live in the harness factory; the core suite additionally owns a
// visual-baseline dir + animation-disabled screenshots for its @visual specs. See
// packages/e2e-harness/src/playwrightConfig.ts for the CI-vs-local rationale
// (contended cold starts widen the expect timeout, 2-core runners cap workers at 2,
// etc).
//
// Single-sourced here because apps/editor/playwright.config.ts — the forwarder that
// catches a bare `playwright test` run from apps/editor — reuses these knobs and
// re-points only the config-file-relative paths. Keep the two in sync through this
// constant, never by copying values.
export const coreSuiteOptions: E2EConfigOptions = {
  snapshotDir: './baselines',
  disableScreenshotAnimations: true,
  // Test-level scheduling: the shared-app fixture keeps one Electron per worker,
  // so spreading a file's tests across workers is cheap and removes the
  // end-of-pass tail (one worker alone on the last big spec files). Extension
  // suites cold-launch per test and stay file-level — see the harness option doc.
  fullyParallel: true,
}

export default defineE2EConfig(coreSuiteOptions)
