/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteInstallOutputContribution — when a remote bring-up performs an actual
 *  server install (upload + npm install), auto-reveal the "Remote Connection"
 *  output channel so the install log stays visible instead of hidden in the panel.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ILayoutService,
  IOutputService,
  IViewsService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  IRemoteStatusService,
  REMOTE_CONNECTION_LOG_CHANNEL_NAME,
  type RemoteConnectionStatusDto,
} from '../../shared/ipc/remoteStatusService.js'
import { revealOutputPanel } from '../services/output/revealOutputPanel.js'

export class RemoteInstallOutputContribution extends Disposable implements IWorkbenchContribution {
  private readonly _revealed = new Set<string>()

  constructor(
    @IRemoteStatusService private readonly _remoteStatus: IRemoteStatusService,
    @IOutputService private readonly _output: IOutputService,
    @ILayoutService private readonly _layout: ILayoutService,
    @IViewsService private readonly _views: IViewsService,
  ) {
    super()
    this._register(this._remoteStatus.onDidChangeState((status) => this._onState(status)))
  }

  private _onState(status: RemoteConnectionStatusDto): void {
    if (status.state === 'idle' || status.state === 'failed' || status.state === 'disposed') {
      this._revealed.delete(status.authority)
      return
    }
    if (status.progress?.needsInstall !== true) return
    if (this._revealed.has(status.authority)) return
    // A persisted output channel is still being restored; skip this event —
    // later install-step events of the same bring-up will retry the reveal.
    if (this._output.hasPendingRestoredChannel) return

    this._revealed.add(status.authority)
    this._output.createChannel(REMOTE_CONNECTION_LOG_CHANNEL_NAME, 'log')
    this._output.setActiveChannel(REMOTE_CONNECTION_LOG_CHANNEL_NAME)
    revealOutputPanel(this._layout, this._views)
  }
}
