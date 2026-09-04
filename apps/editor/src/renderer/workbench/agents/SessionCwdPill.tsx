/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionCwdPill — a small scope badge that shows which sub-project the agent
 *  is working in. Renders only when the session cwd is a *strict* subdirectory
 *  of the open workspace; a root-cwd or not-yet-known cwd renders nothing (the
 *  workspace itself needs no badge). The judgement lives in
 *  `sessionCwdScopeRel` (acpSessionHistory), shared with the editor-tab badge.
 *--------------------------------------------------------------------------------------------*/

import { IUriIdentityService, IWorkspaceService, localize } from '@universe-editor/platform'
import { Folder } from 'lucide-react'
import { useOptionalService } from '../useService.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionModel.js'
import { sessionCwdScopeRel } from '../../services/acp/session/acpSessionHistory.js'
import { shortenScopeLabel } from './scopeLabel.js'
import styles from './agents.module.css'

export function SessionCwdPill({ session }: { session: IAcpSession }) {
  const workspace = useOptionalService(IWorkspaceService)
  const uriIdentity = useOptionalService(IUriIdentityService)

  const root = workspace?.current?.folder
  const rel = uriIdentity ? sessionCwdScopeRel(uriIdentity, root?.fsPath, session.cwd) : null
  if (rel === null) return null

  return (
    <span
      className={styles['sessionCwdPill']}
      data-testid="acp-session-cwd"
      data-tooltip={localize('acp.session.cwd.tooltip', 'Agent working directory: {cwd}', {
        cwd: session.cwd,
      })}
    >
      <Folder size={12} strokeWidth={1.75} aria-hidden="true" />
      {shortenScopeLabel(rel)}
    </span>
  )
}
