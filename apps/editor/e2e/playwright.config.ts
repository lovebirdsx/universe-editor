import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './specs',
  snapshotDir: './baselines',
  timeout: 30_000,
  expect: {
    // CI runners (2 cores, no GPU, 4 Electron instances contending) push cold
    // first-frame mounts — Monaco lazy-load, LSP warmup — past the 5s default.
    // Give expect a wider window on CI; keep it tight locally to catch real lag.
    timeout: process.env['CI'] ? 10_000 : 5_000,
    toHaveScreenshot: { animations: 'disabled' },
  },
  retries: process.env['CI'] ? 1 : 0,
  // 2-core CI runners can't actually run 4 Electron apps in parallel without
  // starving each other's cold start (tsserver/LSP/Monaco), which tips flaky
  // specs over their timeouts — Windows worst. Trade wall-clock for stability.
  workers: process.env['CI'] ? 2 : 4,
  fullyParallel: false,
  reporter: process.env['CI']
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: 'test-results',
})
