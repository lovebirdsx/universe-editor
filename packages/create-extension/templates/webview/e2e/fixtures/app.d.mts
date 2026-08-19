/*---------------------------------------------------------------------------------------------
 *  Type surface for e2e/fixtures/app.mjs + the `window.__E2E__` probe.
 *
 *  The runtime objects come from @universe-editor/e2e-harness (`test`/`expect`
 *  and the cold-launch fixture); the probe type is @universe-editor/e2e-contract,
 *  which augments `window.__E2E__` globally. Both are ordinary devDependencies
 *  here, so the surface re-exports their real types instead of a hand-written
 *  subset. This file deliberately contains no template tokens.
 *--------------------------------------------------------------------------------------------*/

import type { E2ETest } from '@universe-editor/e2e-harness'
import '@universe-editor/e2e-contract'

export const test: E2ETest
export const expect: (typeof import('@universe-editor/e2e-harness'))['expect']
