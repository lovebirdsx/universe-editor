export { expect } from '@playwright/test'

export {
  createColdAppTest,
  createSharedAppTest,
  type AppFixtureConfig,
  type E2EFixtures,
  type E2ETest,
  type LaunchWorkspace,
  type SharedE2EFixtures,
  type SharedE2ETest,
  type WorkspaceSeeder,
} from './fixtures.js'

export {
  closeApp,
  launchApp,
  launchAppReady,
  launchElectron,
  resolveEditorBuild,
  resolveEditorLaunchTarget,
  seedBaselineUserData,
  waitForProbe,
  ENABLED_EXTENSIONS_ENV,
  INITIAL_SETTINGS,
  INITIAL_STATE,
  type EditorBuild,
  type EditorLaunchTarget,
  type LaunchAppOptions,
} from './launch.js'

export { installFailureForensics } from './forensics.js'

export { WorkbenchPO, expectNoLeaks, evaluateWhenRestored } from './pages/WorkbenchPO.js'
export { ActivityBarPO } from './pages/ActivityBarPO.js'
export { SideBarPO } from './pages/SideBarPO.js'
export { StatusBarPO } from './pages/StatusBarPO.js'
export { QuickInputPO } from './pages/QuickInputPO.js'
export { EditorAreaPO } from './pages/EditorAreaPO.js'
export { PanelPO } from './pages/PanelPO.js'
export { AcpTimelinePO } from './pages/AcpTimelinePO.js'

export { defineE2EConfig, type E2EConfigOptions } from './playwrightConfig.js'

// 转发而非要求每个 spec 各自声明依赖：所有 e2e 套件（含 extensions-external 与
// create-extension 模板）都已经从这个 barrel 取东西，临时目录走同一个入口。
export { mkTempDir, effectiveTempRoot, TEMP_PREFIXES } from '@universe-editor/temp-root'

export type {
  E2EDisposableLeakReport,
  E2EOpenWindow,
  E2EUpdateState,
} from '@universe-editor/e2e-contract'
