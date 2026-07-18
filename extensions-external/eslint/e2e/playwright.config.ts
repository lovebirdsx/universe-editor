import { defineE2EConfig } from '../../../packages/e2e-harness/dist/index.js'

// ESLint extension e2e. Shared knobs + tag filtering come from the harness
// factory. Runs the packaged editor build with the ESLint extension loaded off
// disk (see fixtures/eslintApp.ts).
export default defineE2EConfig()
