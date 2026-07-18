/*---------------------------------------------------------------------------------------------
 *  Shared-instance fixture shim.
 *
 *  Binds `@universe-editor/e2e-harness`'s shared-app factory (ONE Electron per
 *  worker, reset between tests) to the editor build. See the harness module for
 *  the launch model and when to prefer this over the cold-launch fixture.
 *--------------------------------------------------------------------------------------------*/

import { createSharedAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

export const test = createSharedAppTest({ appRoot: APP_ROOT, mainEntry: MAIN_ENTRY })

export { expect } from '@universe-editor/e2e-harness'
export type { SharedE2EFixtures } from '@universe-editor/e2e-harness'
