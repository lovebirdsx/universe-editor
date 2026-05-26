/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionEditor — full-screen editor variant of ChatBody. Looks the session
 *  up by id from the AcpSessionService; auto-resumes when the input refers to
 *  a session that exists in history but isn't live yet.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import {
  IEditorInput,
  IEditorService,
  IInstantiationService,
  localize,
} from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import { ChatBody } from './ChatBody.js'
import styles from './agents.module.css'

export function AcpSessionEditor({ input }: { input: IEditorInput }) {
  const service = useService(IAcpSessionService)
  const editor = useService(IEditorService)
  const inst = useService(IInstantiationService)
  useObservable(service.sessions) // re-render when sessions change

  const acpInput = input instanceof AcpSessionEditorInput ? input : undefined
  const session = acpInput ? service.getById(acpInput.sessionId) : undefined

  // One-shot auto-resume: if no live session matches the input's sessionId,
  // kick off `resumeSession`. The service dedupes concurrent resumes for the
  // same id; the ref here just suppresses the second call on the same render
  // (React 19 strict-mode double-invoke) before the dedup map sees it.
  const resumeAttempted = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!acpInput || session) return
    if (resumeAttempted.current === acpInput.sessionId) return
    resumeAttempted.current = acpInput.sessionId
    void service.resumeSession(acpInput.sessionId).catch(() => {
      // resumeSession publishes its own notification; nothing to do here.
    })
  }, [acpInput, service, session])

  if (!acpInput) return null

  if (!session) {
    return (
      <div className={styles['sessionMissing']} data-testid="acp-session-resuming">
        <p>{localize('acp.session.resuming', 'Resuming agent session…')}</p>
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
                  inst.createInstance(AcpSessionEditorInput, fresh.id, fresh.agentId),
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
  return <ChatBody session={session} />
}
