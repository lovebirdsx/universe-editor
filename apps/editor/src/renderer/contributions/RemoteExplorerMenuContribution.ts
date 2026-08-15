/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteExplorerMenuContribution — right-click menu items for Remote Explorer
 *  rows. Gated by the scoped keys the view's RemoteContextMenu seeds:
 *    remoteRowKind   'sshTarget' | 'wslTarget' | 'connection' | 'recent'
 *    remoteRowState  connection state ('' for a target with no live connection)
 *    remoteRowManual manually-added SSH host (forgettable)
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type IWorkbenchContribution,
  MenuId,
  MenuRegistry,
} from '@universe-editor/platform'
import {
  CloseConnectionAction,
  ConnectToHostAction,
  OpenFolderOnHostAction,
  RemoveManualHostAction,
  RetryConnectionAction,
  StopRemoteServerAction,
} from '../actions/remoteActions.js'
import { RemoveRecentWorkspaceAction } from '../actions/workspaceActions.js'

export class RemoteExplorerMenuContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    // Connect — only for targets with no live connection (empty state string).
    for (const kind of ['sshTarget', 'wslTarget'] as const) {
      this._register(
        MenuRegistry.addMenuItem(MenuId.RemoteExplorerContext, {
          command: ConnectToHostAction.ID,
          when: `remoteRowKind == '${kind}' && !remoteRowState`,
          group: '1_connect',
          order: 1,
        }),
      )
    }

    this._register(
      MenuRegistry.addMenuItem(MenuId.RemoteExplorerContext, {
        command: OpenFolderOnHostAction.ID,
        when: "remoteRowState == 'connected'",
        group: '1_connect',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.RemoteExplorerContext, {
        command: RetryConnectionAction.ID,
        when: "remoteRowState == 'failed'",
        group: '1_connect',
        order: 3,
      }),
    )

    // Connection lifecycle — only on live connection rows.
    for (const state of ['connected', 'reconnecting'] as const) {
      this._register(
        MenuRegistry.addMenuItem(MenuId.RemoteExplorerContext, {
          command: CloseConnectionAction.ID,
          when: `remoteRowKind == 'connection' && remoteRowState == '${state}'`,
          group: '2_connection',
          order: 1,
        }),
      )
    }
    this._register(
      MenuRegistry.addMenuItem(MenuId.RemoteExplorerContext, {
        command: StopRemoteServerAction.ID,
        when: "remoteRowKind == 'connection' && remoteRowState == 'connected'",
        group: '2_connection',
        order: 2,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.RemoteExplorerContext, {
        command: RemoveManualHostAction.ID,
        when: "remoteRowKind == 'sshTarget' && remoteRowManual",
        group: '3_manage',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.RemoteExplorerContext, {
        command: RemoveRecentWorkspaceAction.ID,
        when: "remoteRowKind == 'recent'",
        group: '3_manage',
        order: 2,
      }),
    )
  }
}
