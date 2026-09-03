/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionCwdPill — a small scope badge pinned above a session chat that shows
 *  which sub-project the agent is working in. Renders only when the session cwd
 *  is a *strict* subdirectory of the open workspace; a root-cwd or not-yet-known
 *  cwd renders nothing (the workspace itself needs no badge).
 *--------------------------------------------------------------------------------------------*/

import { IUriIdentityService, IWorkspaceService, localize } from '@universe-editor/platform'
import { Folder } from 'lucide-react'
import { useService } from '../useService.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionModel.js'
import { isDescendantOrEqual } from '../../services/acp/session/acpSessionHistory.js'
import { shortenScopeLabel } from './scopeLabel.js'
import styles from './agents.module.css'

export function SessionCwdPill({ session }: { session: IAcpSession }) {
  const workspace = useService(IWorkspaceService)
  const uriIdentity = useService(IUriIdentityService)

  const root = workspace.current?.folder
  const cwd = session.cwd
  if (root === undefined || cwd === undefined) return null
  if (!isDescendantOrEqual(uriIdentity, root.fsPath, cwd)) return null
  const rel = uriIdentity.relativePathUnder(root.fsPath, cwd)
  if (rel === null || rel === '') return null

  return (
    <span
      className={styles['sessionCwdPill']}
      data-testid="acp-session-cwd"
      data-tooltip={localize('acp.session.cwd.tooltip', 'Agent working directory: {cwd}', { cwd })}
    >
      <Folder size={12} strokeWidth={1.75} aria-hidden="true" />
      {shortenScopeLabel(rel)}
    </span>
  )
}
