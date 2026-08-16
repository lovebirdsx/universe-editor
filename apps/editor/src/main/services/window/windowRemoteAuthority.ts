/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure derivation of the window-level remote-ssh authority: which authority a
 *  (possibly empty) window is scoped to at creation. Mirrored on the renderer
 *  side by currentRemoteAuthority() in services/remote/windowRemoteAuthority.ts.
 *--------------------------------------------------------------------------------------------*/

import { REMOTE_SCHEME, normalizeRemoteAuthority, type URI } from '@universe-editor/platform'

export function deriveWindowRemoteAuthority(
  workspaceFolder: URI | undefined,
  optionAuthority: string | undefined,
): string | undefined {
  if (workspaceFolder !== undefined) {
    if (workspaceFolder.scheme !== REMOTE_SCHEME) return undefined
    if (!workspaceFolder.authority) return undefined
    return normalizeRemoteAuthority(workspaceFolder.authority)
  }
  if (!optionAuthority) return undefined
  return normalizeRemoteAuthority(optionAuthority)
}
