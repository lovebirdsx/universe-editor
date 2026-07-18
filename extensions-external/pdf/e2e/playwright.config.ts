import { defineE2EConfig } from '../../../packages/e2e-harness/dist/index.js'

// PDF extension e2e. Shared knobs (timeout / retries / workers / reporter /
// trace-on-failure) + tag filtering come from the harness factory so behaviour
// matches the core + built-in extension suites. Runs the packaged editor build
// with the PDF extension loaded off disk (see fixtures/pdfApp.ts).
export default defineE2EConfig()
