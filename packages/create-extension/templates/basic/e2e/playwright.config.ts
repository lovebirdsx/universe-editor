import { defineE2EConfig } from '@universe-editor/e2e-harness'

// Shared knobs (timeout / retries / workers / reporter / trace-on-failure) +
// tag filtering come from the harness factory. Specs live in ./specs (the
// factory's default testDir, resolved against this file).
export default defineE2EConfig()
