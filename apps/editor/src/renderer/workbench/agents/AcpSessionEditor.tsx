/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionEditor — full-screen editor variant of ChatView. Looks the session
 *  up by id from the AcpSessionService.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
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

  // Resolve the matching live session. After an editor restart the local
  // `sessionId` is stale (regenerated each run), so historyId — the durable
  // handle from AcpSessionHistoryService — wins when present.
  const acpInput = input instanceof AcpSessionEditorInput ? input : undefined
  const session = acpInput
    ? ((acpInput.historyId ? service.getByHistoryId(acpInput.historyId) : undefined) ??
      service.getById(acpInput.sessionId))
    : undefined

  // One-shot auto-resume: if the input carries a historyId but no live session
  // matches, kick off `resumeSession`. The ref guards against double-firing
  // across re-renders (and against React 19 strict-mode double-invoke during
  // dev, which would otherwise spawn two agent processes).
  const resumeAttempted = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!acpInput || session || !acpInput.historyId) return
    if (resumeAttempted.current === acpInput.historyId) return
    resumeAttempted.current = acpInput.historyId
    void service.resumeSession(acpInput.historyId).catch(() => {
      // resumeSession publishes its own notification; nothing to do here.
    })
  }, [acpInput, service, session])

  if (!acpInput) return null

  if (!session) {
    if (acpInput.historyId) {
      return (
        <div className={styles['sessionMissing']} data-testid="acp-session-resuming">
          <p>{localize('acp.session.resuming', 'Resuming agent session…')}</p>
        </div>
      )
    }
    // After a hot exit the agent subprocess is gone, but a serialized
    // AcpSessionEditorInput is still being restored. If the input carries the
    // original agentId, give the user a one-click way to launch a fresh session
    // for that agent — anything richer (reattach to live process) is out of
    // scope while sessions live entirely in renderer memory.
    return (
      <div className={styles['sessionMissing']}>
        <p>{localize('acp.session.missing', 'Session no longer available.')}</p>
        {acpInput.agentId && (
          <button
            type="button"
            data-testid="acp-session-reconnect"
            onClick={() => {
              const agentId = acpInput.agentId!
              const inputId = acpInput.id
              void (async () => {
                const fresh = await service.createSession(agentId)
                editor.openEditor(
                  new AcpSessionEditorInput(fresh.id, fresh.agentId, fresh.historyId),
                )
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
