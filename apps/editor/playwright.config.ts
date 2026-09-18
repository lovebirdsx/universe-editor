import { defineE2EConfig } from '@universe-editor/e2e-harness'
import { coreSuiteOptions } from './e2e/playwright.config.js'

// Forwarder for a bare `playwright test` run from apps/editor.
//
// Playwright looks for playwright.config.* in the CWD only, never in a parent
// directory. Without this file that lookup fails and the built-in defaults take over:
// no globalSetup (so no offscreen Xvfb — on WSL the real DISPLAY shines through and
// every Electron window lands on the Windows desktop), no tag filtering, no linux
// preflight, no build guard. This config makes such an invocation resolve to the same
// suite config as `-c e2e/playwright.config.ts`.
//
// testDir / snapshotDir / outputDir are all resolved against the config file's own
// directory, and this file sits one level above e2e/ — hence the re-pointing. The
// suite knobs themselves stay single-sourced in coreSuiteOptions.
//
// Not re-pointed on purpose: the html reporter's outputFolder. It only takes effect
// when CI=1 AND the invocation is config-less, which cannot happen — CI always passes
// `-c e2e/playwright.config.ts`, and locally the reporter is `list`.
export default defineE2EConfig({
  ...coreSuiteOptions,
  testDir: './e2e/specs',
  snapshotDir: './e2e/baselines',
  outputDir: './e2e/test-results',
})
