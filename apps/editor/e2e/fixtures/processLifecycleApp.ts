/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for the process-lifecycle specs. Turns the ACP orphan sweep off so
 *  each assertion can be attributed to exactly one mechanism: window/owner reclaim and the
 *  release-time reap (P0). The sweep itself has its own fixture (processLifecycleOrphanApp),
 *  which runs it fast instead.
 *--------------------------------------------------------------------------------------------*/

import { createColdAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

export const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: [],
  env: { UNIVERSE_DISABLE_ORPHAN_SWEEP: '1' },
})

export { expect, closeApp } from '@universe-editor/e2e-harness'
export type { E2EFixtures } from '@universe-editor/e2e-harness'
