/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConnectionsViewToolbar — the "Connections" view header widget: a muted
 *  active-connection count badge (non-interactive).
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { useObservable, useService } from '../useService.js'
import { IRemoteExplorerService } from '../../services/remote/RemoteExplorerService.js'
import styles from './RemoteExplorer.module.css'

export function ConnectionsViewToolbar() {
  const explorer = useService(IRemoteExplorerService)
  const connections = useObservable(explorer.connections)
  const activeCount = useMemo(
    () => connections.filter((c) => c.state !== 'idle' && c.state !== 'disposed').length,
    [connections],
  )

  return <span className={styles['count']}>{activeCount}</span>
}
