/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WslTargetsView — the "WSL Targets" view of the Remote Explorer container.
 *  Only registered-visible while `hasWslDistros` holds (see
 *  RemoteExplorerContextContribution), so it has no empty state of its own.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { FolderOpen, Plug, RefreshCw } from 'lucide-react'
import { ICommandService, localize, wslAuthorityForDistro } from '@universe-editor/platform'
import { IconButton } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { IRemoteExplorerService } from '../../services/remote/RemoteExplorerService.js'
import type {
  RemoteConnectionStateDto,
  WslDistroDto,
} from '../../../shared/ipc/remoteStatusService.js'
import {
  ConnectToHostAction,
  OpenFolderOnHostAction,
  RetryConnectionAction,
} from '../../actions/remoteActions.js'
import { RemoteRow } from './RemoteRow.js'
import { RemoteContextMenu } from './RemoteContextMenu.js'
import { remoteRowPrimaryAction } from './remoteRowActions.js'
import { useRemoteRowMenu } from './useRemoteRowMenu.js'
import styles from './RemoteExplorer.module.css'

export function WslTargetsView() {
  const explorer = useService(IRemoteExplorerService)
  const wslDistros = useObservable(explorer.wslDistros)
  const connections = useObservable(explorer.connections)
  const { menu, openMenu, closeMenu } = useRemoteRowMenu()

  const connectionState = useCallback(
    (authority: string): RemoteConnectionStateDto | undefined =>
      connections.find((c) => c.authority === authority)?.state,
    [connections],
  )

  return (
    <div className={styles['view']} data-testid="remote-wsl-targets-view">
      {wslDistros.map((distro) => (
        <WslTargetRow
          key={distro.name}
          distro={distro}
          state={connectionState(wslAuthorityForDistro(distro.name))}
          onContextMenu={openMenu({
            kind: 'wslTarget',
            state: connectionState(wslAuthorityForDistro(distro.name)),
            manual: false,
            arg: wslAuthorityForDistro(distro.name),
          })}
        />
      ))}
      {menu && <RemoteContextMenu state={menu} onClose={closeMenu} />}
    </div>
  )
}

function WslTargetRow({
  distro,
  state,
  onContextMenu,
}: {
  distro: WslDistroDto
  state: RemoteConnectionStateDto | undefined
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
}) {
  const commands = useService(ICommandService)
  const authority = wslAuthorityForDistro(distro.name)
  const connected = state === 'connected'
  const failed = state === 'failed'
  const primary = remoteRowPrimaryAction(state)
  const tooltip = distro.isRunning
    ? localize('remote.wsl.runningTooltip', '{name} (running)', { name: distro.name })
    : distro.name

  return (
    <RemoteRow
      testId="remote-wsl-target-row"
      dot={state}
      label={distro.name}
      tooltip={tooltip}
      description={distro.isDefault ? localize('remote.wsl.default', 'default') : undefined}
      onActivate={
        primary === null ? undefined : () => void commands.executeCommand(primary, authority)
      }
      onContextMenu={onContextMenu}
      actions={
        <>
          {connected && (
            <IconButton
              label={localize('remote.target.openFolder', 'Open Folder on Host...')}
              onClick={() => void commands.executeCommand(OpenFolderOnHostAction.ID, authority)}
            >
              <FolderOpen size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          {failed && (
            <IconButton
              label={localize('remote.connection.retry', 'Retry Connection')}
              onClick={() => void commands.executeCommand(RetryConnectionAction.ID, authority)}
            >
              <RefreshCw size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          {!connected && !failed && (
            <IconButton
              label={localize('remote.wsl.connect', 'Connect to WSL...')}
              onClick={() => void commands.executeCommand(ConnectToHostAction.ID, authority)}
            >
              <Plug size={14} strokeWidth={1.75} />
            </IconButton>
          )}
        </>
      }
    />
  )
}
