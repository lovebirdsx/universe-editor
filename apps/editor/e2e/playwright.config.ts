import { defineE2EConfig } from '@universe-editor/e2e-harness'

// Core suite config. Shared knobs (timeout / retries / workers / reporter /
// trace-on-failure) live in the harness factory; the core suite additionally
// owns a visual-baseline dir + animation-disabled screenshots for its @visual
// specs. See packages/e2e-harness/src/playwrightConfig.ts for the CI-vs-local
// rationale (contended cold starts widen the expect timeout, 2-core runners cap
// workers at 2, etc).
export default defineE2EConfig({
  snapshotDir: './baselines',
  disableScreenshotAnimations: true,
})
