import { defineE2EConfig } from '@universe-editor/e2e-harness'

// TypeScript extension e2e. Shared knobs (timeout / retries / workers / reporter /
// trace-on-failure) come from the harness factory so tag filtering / CI sharding
// behave identically to the core suite. Runs the packaged editor build with ONLY
// the TypeScript extension activated (see fixtures/typescriptApp.ts).
export default defineE2EConfig()
