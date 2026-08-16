/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote badge in the title bar — shows the window's remote authority
 *  ("WSL: ubuntu-24.04" / "SSH: host") and opens the remote menu on click.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useSyncExternalStore } from 'react'
import {
  ICommandService,
  IWorkspaceService,
  localize,
  remoteAuthorityLabel,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { currentRemoteAuthority } from '../../services/remote/windowRemoteAuthority.js'
import styles from './TitleBar.module.css'

// Command id defined in RemoteStatusContribution.ts (REMOTE_STATUS_MENU_COMMAND_ID).
const REMOTE_STATUS_MENU_COMMAND_ID = 'workbench.action.remote.showMenu'

export function RemoteBadge() {
  const workspace = useService(IWorkspaceService)
  const commandService = useService(ICommandService)

  const subscribe = useCallback(
    (onChange: () => void) => {
      const disposable = workspace.onDidChangeWorkspace(() => onChange())
      return () => disposable.dispose()
    },
    [workspace],
  )

  const authority = useSyncExternalStore(
    subscribe,
    () => currentRemoteAuthority(workspace.current) ?? '',
  )

  if (!authority) return null

  return (
    <button
      type="button"
      className={styles['remote-badge']}
      onClick={() => void commandService.executeCommand(REMOTE_STATUS_MENU_COMMAND_ID)}
      data-tooltip={localize('titlebar.remoteBadge.tooltip', 'Remote: {authority}', { authority })}
      data-testid="titlebar-remote-badge"
      aria-label={localize('titlebar.remoteBadge.tooltip', 'Remote: {authority}', { authority })}
    >
      <span
        className={`codicon codicon-remote ${styles['remote-badge-icon']}`}
        aria-hidden="true"
      />
      <span>{remoteAuthorityLabel(authority)}</span>
    </button>
  )
}
