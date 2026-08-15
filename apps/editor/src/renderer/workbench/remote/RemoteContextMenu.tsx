/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteContextMenu — the right-click menu for Remote Explorer rows. Thin
 *  wrapper over the workbench-ui ContextMenu: items come from MenuRegistry
 *  (RemoteExplorerMenuContribution registers them at BlockStartup), gated by
 *  the per-row scoped keys seeded here (same pattern as ExplorerContextMenu).
 *  The row's identifier (host authority or recent folder URI) is passed as the
 *  command's first argument.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo } from 'react'
import {
  ICommandService,
  IContextKeyService,
  MenuId,
  markAsSingleton,
} from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import type { RemoteConnectionStateDto } from '../../../shared/ipc/remoteStatusService.js'
import { useService } from '../useService.js'

export type RemoteRowMenuKind = 'sshTarget' | 'wslTarget' | 'connection' | 'recent'

export interface RemoteMenuState {
  readonly x: number
  readonly y: number
  readonly target: {
    readonly kind: RemoteRowMenuKind
    readonly state: RemoteConnectionStateDto | undefined
    readonly manual: boolean
    /** ssh/wsl/connection rows: the authority; recent rows: the folder URI string. */
    readonly arg: string
  }
}

interface Props {
  readonly state: RemoteMenuState
  readonly onClose: () => void
}

export function RemoteContextMenu({ state, onClose }: Props) {
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const { kind, state: rowState, manual } = state.target

  const scoped = useMemo(
    () =>
      markAsSingleton(
        contextKeyService.createScoped({
          remoteRowKind: kind,
          remoteRowState: rowState ?? '',
          remoteRowManual: manual,
        }),
      ),
    [contextKeyService, kind, rowState, manual],
  )
  useEffect(() => () => scoped.dispose(), [scoped])

  return (
    <ContextMenu
      menuId={MenuId.RemoteExplorerContext}
      anchor={{ x: state.x, y: state.y }}
      args={[state.target.arg]}
      commandService={commandService}
      contextKeyService={scoped}
      onClose={onClose}
    />
  )
}
