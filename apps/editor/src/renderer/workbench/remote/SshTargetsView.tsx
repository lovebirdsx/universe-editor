/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SshTargetsView — the "SSH Targets" view of the Remote Explorer container:
 *  ~/.ssh/config hosts + manually-added hosts, each row showing its live
 *  connection state. Left-click / Enter runs the row's primary action
 *  (connect / open folder / retry per state); hover reveals the same actions
 *  as floating buttons; right-click opens the RemoteExplorerContext menu.
 *  This view owns the explorer's mount-triggered refresh (it is the only
 *  always-present view, so data is fetched exactly once per container open).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect } from 'react'
import { FolderOpen, Plug, RefreshCw, X } from 'lucide-react'
import { ICommandService, localize } from '@universe-editor/platform'
import { IconButton } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import {
  IRemoteExplorerService,
  type RemoteSshTarget,
} from '../../services/remote/RemoteExplorerService.js'
import type { RemoteConnectionStateDto } from '../../../shared/ipc/remoteStatusService.js'
import {
  ConnectToHostAction,
  OpenFolderOnHostAction,
  RemoveManualHostAction,
  RetryConnectionAction,
} from '../../actions/remoteActions.js'
import { RemoteRow } from './RemoteRow.js'
import { RemoteContextMenu } from './RemoteContextMenu.js'
import { remoteRowPrimaryAction } from './remoteRowActions.js'
import { useRemoteRowMenu } from './useRemoteRowMenu.js'
import styles from './RemoteExplorer.module.css'

export function SshTargetsView() {
  const explorer = useService(IRemoteExplorerService)
  const sshTargets = useObservable(explorer.sshTargets)
  const connections = useObservable(explorer.connections)
  const { menu, openMenu, closeMenu } = useRemoteRowMenu()

  // The view only mounts while visible, so refreshing on mount is "refresh on open".
  useEffect(() => {
    void explorer.refresh()
  }, [explorer])

  const connectionState = useCallback(
    (authority: string): RemoteConnectionStateDto | undefined =>
      connections.find((c) => c.authority === authority)?.state,
    [connections],
  )

  return (
    <div className={styles['view']} data-testid="remote-ssh-targets-view">
      {sshTargets.length === 0 && (
        <div className={styles['empty']}>
          {localize('remote.targets.empty', 'No SSH targets. Add one or use an SSH config.')}
        </div>
      )}
      {sshTargets.map((target) => (
        <TargetRow
          key={target.host}
          target={target}
          state={connectionState(target.host)}
          onContextMenu={openMenu({
            kind: 'sshTarget',
            state: connectionState(target.host),
            manual: target.manual,
            arg: target.host,
          })}
        />
      ))}
      {menu && <RemoteContextMenu state={menu} onClose={closeMenu} />}
    </div>
  )
}

function TargetRow({
  target,
  state,
  onContextMenu,
}: {
  target: RemoteSshTarget
  state: RemoteConnectionStateDto | undefined
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
}) {
  const commands = useService(ICommandService)
  const connected = state === 'connected'
  const failed = state === 'failed'
  const primary = remoteRowPrimaryAction(state)

  return (
    <RemoteRow
      testId="remote-target-row"
      dot={state}
      label={target.host}
      tooltip={target.host}
      onActivate={
        primary === null ? undefined : () => void commands.executeCommand(primary, target.host)
      }
      onContextMenu={onContextMenu}
      actions={
        <>
          {connected && (
            <IconButton
              label={localize('remote.target.openFolder', 'Open Folder on Host...')}
              onClick={() => void commands.executeCommand(OpenFolderOnHostAction.ID, target.host)}
            >
              <FolderOpen size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          {failed && (
            <IconButton
              label={localize('remote.connection.retry', 'Retry Connection')}
              onClick={() => void commands.executeCommand(RetryConnectionAction.ID, target.host)}
            >
              <RefreshCw size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          {!connected && !failed && (
            <IconButton
              label={localize('remote.target.connect', 'Connect to Host...')}
              onClick={() => void commands.executeCommand(ConnectToHostAction.ID, target.host)}
            >
              <Plug size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          {target.manual && (
            <IconButton
              label={localize('remote.target.forget', 'Forget')}
              onClick={() => void commands.executeCommand(RemoveManualHostAction.ID, target.host)}
            >
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          )}
        </>
      }
    />
  )
}
