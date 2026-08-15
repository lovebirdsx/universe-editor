/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteRecentView — the "Recent" view of the Remote Explorer container:
 *  recently-opened remote-ssh workspaces (click to re-open, hover button or
 *  right-click menu to remove).
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { X } from 'lucide-react'
import {
  ICommandService,
  IWorkspaceService,
  REMOTE_SCHEME,
  localize,
  type IRecentWorkspace,
} from '@universe-editor/platform'
import { IconButton } from '@universe-editor/workbench-ui'
import { useEventValue, useService } from '../useService.js'
import { RemoveRecentWorkspaceAction } from '../../actions/workspaceActions.js'
import { workspaceFullLabel } from '../../services/workspace/workspaceLabel.js'
import { RemoteRow } from './RemoteRow.js'
import { RemoteContextMenu } from './RemoteContextMenu.js'
import { useRemoteRowMenu } from './useRemoteRowMenu.js'
import styles from './RemoteExplorer.module.css'

export function RemoteRecentView() {
  const workspace = useService(IWorkspaceService)
  const { menu, openMenu, closeMenu } = useRemoteRowMenu()
  const recent = useEventValue(
    workspace.onDidChangeRecent,
    useCallback(
      () => workspace.recent.filter((r) => r.folder.scheme === REMOTE_SCHEME),
      [workspace],
    ),
  )

  return (
    <div className={styles['view']} data-testid="remote-recent-view">
      {recent.length === 0 && (
        <div className={styles['empty']}>{localize('remote.recent.empty', 'None')}</div>
      )}
      {recent.map((entry) => (
        <RecentRow
          key={entry.folder.toString()}
          entry={entry}
          onContextMenu={openMenu({
            kind: 'recent',
            state: undefined,
            manual: false,
            arg: entry.folder.toString(),
          })}
        />
      ))}
      {menu && <RemoteContextMenu state={menu} onClose={closeMenu} />}
    </div>
  )
}

function RecentRow({
  entry,
  onContextMenu,
}: {
  entry: IRecentWorkspace
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
}) {
  const workspace = useService(IWorkspaceService)
  const commands = useService(ICommandService)

  return (
    <RemoteRow
      testId="remote-recent-row"
      label={entry.name}
      tooltip={workspaceFullLabel(entry.folder)}
      onActivate={() => void workspace.openFolder(entry.folder)}
      onContextMenu={onContextMenu}
      actions={
        <IconButton
          label={localize('remote.recent.remove', 'Remove from Recent')}
          onClick={() =>
            void commands.executeCommand(RemoveRecentWorkspaceAction.ID, entry.folder.toString())
          }
        >
          <X size={14} strokeWidth={1.75} />
        </IconButton>
      }
    />
  )
}
