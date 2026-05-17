import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: process.env['CI'] ? 1 : 0,
  // Electron 当前只起一个窗口，多 worker 会抢焦点;
  // M1 阶段保持串行,后续可按 spec 隔离 launch.
  workers: 1,
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
