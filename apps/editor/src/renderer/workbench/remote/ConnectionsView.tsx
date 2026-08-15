/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConnectionsView — the "Connections" view of the Remote Explorer container:
 *  live per-authority connections (connected / reconnecting / failed…).
 *  Row actions mirror the connection lifecycle commands; the "open" variants
 *  only show for connected authorities, retry for failed ones.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { FolderOpen, RefreshCw, Square, X } from 'lucide-react'
import { ICommandService, localize } from '@universe-editor/platform'
import { IconButton } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { IRemoteExplorerService } from '../../services/remote/RemoteExplorerService.js'
import type { RemoteConnectionStateDto } from '../../../shared/ipc/remoteStatusService.js'
import {
  CloseConnectionAction,
  OpenFolderOnHostAction,
  RetryConnectionAction,
  StopRemoteServerAction,
} from '../../actions/remoteActions.js'
import { RemoteRow } from './RemoteRow.js'
import { RemoteContextMenu } from './RemoteContextMenu.js'
import { remoteRowPrimaryAction } from './remoteRowActions.js'
import { useRemoteRowMenu } from './useRemoteRowMenu.js'
import styles from './RemoteExplorer.module.css'

export function ConnectionsView() {
  const explorer = useService(IRemoteExplorerService)
  const connections = useObservable(explorer.connections)
  const activeConnections = useMemo(
    () => connections.filter((c) => c.state !== 'idle' && c.state !== 'disposed'),
    [connections],
  )
  const { menu, openMenu, closeMenu } = useRemoteRowMenu()

  return (
    <div className={styles['view']} data-testid="remote-connections-view">
      {activeConnections.length === 0 && (
        <div className={styles['empty']}>{localize('remote.connections.empty', 'None')}</div>
      )}
      {activeConnections.map((c) => (
        <ConnectionRow
          key={c.authority}
          authority={c.authority}
          state={c.state}
          onContextMenu={openMenu({
            kind: 'connection',
            state: c.state,
            manual: false,
            arg: c.authority,
          })}
        />
      ))}
      {menu && <RemoteContextMenu state={menu} onClose={closeMenu} />}
    </div>
  )
}

function ConnectionRow({
  authority,
  state,
  onContextMenu,
}: {
  authority: string
  state: RemoteConnectionStateDto
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
}) {
  const commands = useService(ICommandService)
  const primary = remoteRowPrimaryAction(state)

  return (
    <RemoteRow
      testId="remote-connection-row"
      dot={state}
      label={authority}
      tooltip={authority}
      onActivate={
        primary === null ? undefined : () => void commands.executeCommand(primary, authority)
      }
      onContextMenu={onContextMenu}
      actions={
        <>
          {state === 'connected' && (
            <IconButton
              label={localize('remote.connection.openFolder', 'Open Folder on Host...')}
              onClick={() => void commands.executeCommand(OpenFolderOnHostAction.ID, authority)}
            >
              <FolderOpen size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          {state === 'failed' && (
            <IconButton
              label={localize('remote.connection.retry', 'Retry Connection')}
              onClick={() => void commands.executeCommand(RetryConnectionAction.ID, authority)}
            >
              <RefreshCw size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          {(state === 'connected' || state === 'reconnecting') && (
            <IconButton
              label={localize('remote.connection.close', 'Close Connection')}
              onClick={() => void commands.executeCommand(CloseConnectionAction.ID, authority)}
            >
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          {state === 'connected' && (
            <IconButton
              label={localize('remote.connection.stopServer', 'Stop Remote Server')}
              onClick={() => void commands.executeCommand(StopRemoteServerAction.ID, authority)}
            >
              <Square size={14} strokeWidth={1.75} />
            </IconButton>
          )}
        </>
      }
    />
  )
}
