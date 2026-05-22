/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionEditor — full-screen editor variant of ChatView. Looks the session
 *  up by id from the AcpSessionService.
 *--------------------------------------------------------------------------------------------*/

import { IEditorInput, IEditorService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import { ChatView } from './ChatView.js'
import styles from './agents.module.css'

export function AcpSessionEditor({ input }: { input: IEditorInput }) {
  const service = useService(IAcpSessionService)
  const editor = useService(IEditorService)
  useObservable(service.sessions) // re-render when sessions change
  if (!(input instanceof AcpSessionEditorInput)) return null
  const session = service.getById(input.sessionId)
  if (!session) {
    // After a hot exit the agent subprocess is gone, but a serialized
    // AcpSessionEditorInput is still being restored. If the input carries the
    // original agentId, give the user a one-click way to launch a fresh session
    // for that agent — anything richer (reattach to live process) is out of
    // scope while sessions live entirely in renderer memory.
    return (
      <div className={styles['sessionMissing']}>
        <p>{localize('acp.session.missing', 'Session no longer available.')}</p>
        {input.agentId && (
          <button
            type="button"
            data-testid="acp-session-reconnect"
            onClick={() => {
              const agentId = input.agentId!
              const inputId = input.id
              void (async () => {
                const fresh = await service.createSession(agentId)
                editor.openEditor(new AcpSessionEditorInput(fresh.id, fresh.agentId))
                editor.closeEditor(inputId)
              })()
            }}
          >
            {localize('acp.session.reconnect', 'Start a new session with the same agent')}
          </button>
        )}
      </div>
    )
  }
  return <ChatView session={session} />
}
