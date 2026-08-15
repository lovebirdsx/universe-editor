/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RecentViewToolbar — the "Recent" view header widget: a muted count badge
 *  for remote-ssh workspaces in Open Recent (non-interactive).
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { IWorkspaceService, REMOTE_SCHEME } from '@universe-editor/platform'
import { useEventValue, useService } from '../useService.js'
import styles from './RemoteExplorer.module.css'

export function RecentViewToolbar() {
  const workspace = useService(IWorkspaceService)
  const recentCount = useEventValue(
    workspace.onDidChangeRecent,
    useCallback(
      () => workspace.recent.filter((r) => r.folder.scheme === REMOTE_SCHEME).length,
      [workspace],
    ),
  )

  return <span className={styles['count']}>{recentCount}</span>
}
