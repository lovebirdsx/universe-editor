import { defineE2EConfig } from '@universe-editor/e2e-harness'

// AI extension e2e. Shared knobs (timeout / retries / workers / reporter /
// trace-on-failure) come from the harness factory so tag filtering / CI sharding
// behave identically to the core suite. Specs self-launch via fixtures/aiApp.ts,
// which activates only the git + ai extensions (P2 minimal set).
export default defineE2EConfig()
