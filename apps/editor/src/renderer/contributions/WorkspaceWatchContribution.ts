/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Arms the cold-start Explorer file watcher once the workbench reaches
 *  WorkbenchPhase.Eventually — reliably after first mount, unlike a raw
 *  runWhenIdle() called during DI construction, which can fire before the
 *  Ready-phase restore work even begins (measured empirically: see
 *  docs/plan/startup-defer-parcel-watch-plan.md). ExplorerTreeService's cold
 *  `_setRoot` call skips the parcel recursive subscribe; this contribution is
 *  what actually starts it, off the first-screen restore's critical path.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
} from '../services/explorer/ExplorerTreeService.js'

export class WorkspaceWatchContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IExplorerTreeService explorerTreeService: ExplorerTreeService) {
    super()
    explorerTreeService.startWatching()
  }
}
