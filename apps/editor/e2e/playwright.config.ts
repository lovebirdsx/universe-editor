import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: process.env['CI'] ? 1 : 0,
  workers: 4,
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
