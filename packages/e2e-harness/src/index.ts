export { expect } from '@playwright/test'

export {
  createColdAppTest,
  createSharedAppTest,
  type AppFixtureConfig,
  type E2EFixtures,
  type E2ETest,
  type SharedE2EFixtures,
  type SharedE2ETest,
} from './fixtures.js'

export {
  closeApp,
  launchApp,
  resolveEditorBuild,
  seedBaselineUserData,
  ENABLED_EXTENSIONS_ENV,
  INITIAL_SETTINGS,
  INITIAL_STATE,
  type EditorBuild,
  type LaunchAppOptions,
} from './launch.js'

export { waitForProbe } from './fixtures.js'

export { WorkbenchPO, expectNoLeaks, evaluateWhenRestored } from './pages/WorkbenchPO.js'
export { ActivityBarPO } from './pages/ActivityBarPO.js'
export { SideBarPO } from './pages/SideBarPO.js'
export { StatusBarPO } from './pages/StatusBarPO.js'
export { QuickInputPO } from './pages/QuickInputPO.js'
export { EditorAreaPO } from './pages/EditorAreaPO.js'
export { PanelPO } from './pages/PanelPO.js'

export type {
  E2EDisposableLeakReport,
  E2EOpenWindow,
  E2EUpdateState,
} from '@universe-editor/e2e-contract'
