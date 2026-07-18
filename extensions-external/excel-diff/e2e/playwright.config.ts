import { defineE2EConfig } from '../../../packages/e2e-harness/dist/index.js'

// Excel viewer & diff extension e2e. Shared knobs + tag filtering come from the
// harness factory. Runs the packaged editor build with the Excel extension loaded
// off disk (see fixtures/excelApp.ts).
export default defineE2EConfig()
