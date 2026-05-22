/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionEditor — full-screen editor variant of ChatView. Looks the session
 *  up by id from the AcpSessionService.
 *--------------------------------------------------------------------------------------------*/

import { IEditorInput, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import { ChatView } from './ChatView.js'
import styles from './agents.module.css'

export function AcpSessionEditor({ input }: { input: IEditorInput }) {
  const service = useService(IAcpSessionService)
  useObservable(service.sessions) // re-render when sessions change
  if (!(input instanceof AcpSessionEditorInput)) return null
  const session = service.getById(input.sessionId)
  if (!session) {
    return (
      <div className={styles['sessionMissing']}>
        {localize('acp.session.missing', 'Session no longer available.')}
      </div>
    )
  }
  return <ChatView session={session} />
}
