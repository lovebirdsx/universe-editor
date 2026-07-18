import { defineConfig } from '@playwright/test'

// TypeScript extension e2e. Mirrors apps/editor/e2e/playwright.config.ts (the core
// suite) so tag filtering / CI sharding behave identically; only the testDir and
// the report/output folders differ. Runs the packaged editor build with ONLY the
// TypeScript extension activated (see fixtures/typescriptApp.ts).
export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  expect: {
    timeout: process.env['CI'] ? 10_000 : 5_000,
  },
  retries: process.env['CI'] ? 1 : 0,
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
