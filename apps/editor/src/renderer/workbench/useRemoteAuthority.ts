/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useRemoteAuthority — derive the remote-ssh authority of the current workspace
 *  folder (undefined for a local folder or no workspace).
 *
 *  Workspace hydration is async: the renderer workspace service populates
 *  `current` from a cross-process roundtrip and fires `onDidChangeWorkspace` when
 *  it settles. The authority must therefore be derived by subscribing to that
 *  event, not memoized from the DI singleton — otherwise an agent settings tab
 *  mounted during startup restore freezes the authority as `undefined` and reads
 *  / writes the wrong (local) host for the rest of the session.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { Event, IWorkspaceService, REMOTE_SCHEME } from '@universe-editor/platform'
import { useEventValue, useOptionalService } from './useService.js'

export function useRemoteAuthority(): string | undefined {
  const workspace = useOptionalService(IWorkspaceService)
  const getValue = useCallback(() => {
    const folder = workspace?.current?.folder
    return folder && folder.scheme === REMOTE_SCHEME ? folder.authority || undefined : undefined
  }, [workspace])
  return useEventValue(workspace?.onDidChangeWorkspace ?? Event.None, getValue)
}
