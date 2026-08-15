/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteTargetsViewToolbar — the "Targets" view header action: add a manual
 *  SSH host via a quick-input prompt.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { Plus } from 'lucide-react'
import { IQuickInputService, localize } from '@universe-editor/platform'
import { IconButton } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { IRemoteExplorerService } from '../../services/remote/RemoteExplorerService.js'

export function RemoteTargetsViewToolbar() {
  const explorer = useService(IRemoteExplorerService)
  const quickInput = useService(IQuickInputService)

  const addNewHost = useCallback(async () => {
    const host = await quickInput.input({
      prompt: localize('remote.addHost.prompt', 'SSH host'),
      placeholder: localize('remote.addHost.placeholder', 'user@host[:port]'),
    })
    if (host === undefined || host.trim() === '') return
    await explorer.addManualHost(host)
  }, [explorer, quickInput])

  return (
    <IconButton
      label={localize('remote.addHost.title', 'Add New SSH Host')}
      onClick={() => void addNewHost()}
    >
      <Plus size={14} strokeWidth={1.75} />
    </IconButton>
  )
}
