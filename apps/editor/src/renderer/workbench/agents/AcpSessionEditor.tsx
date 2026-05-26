/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionEditor — full-screen editor variant of ChatBody. Looks the session
 *  up by id from the AcpSessionService; auto-resumes when the input refers to
 *  a session that exists in history but isn't live yet.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { AlertCircle, Loader2, RotateCw } from 'lucide-react'
import { IEditorInput, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { IAcpSessionHistoryService } from '../../services/acp/acpSessionHistory.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import { ChatBody } from './ChatBody.js'
import styles from './agents.module.css'

type ResumePhase = { kind: 'idle' } | { kind: 'pending' } | { kind: 'error'; message: string }

export function AcpSessionEditor({ input }: { input: IEditorInput }) {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  useObservable(service.sessions)
  // 订阅 history 是为了让水化完成时触发重渲——_resumeSessionInner 在 history hydrate 之前
  // 可能 throw "Unknown agent session id"，那次失败后用户没有显式动作的话就需要这条路径
  // 把组件叫醒，让 useEffect 在 phase 转回 idle 后重新尝试 resume。
  useObservable(history.entries)

  const acpInput = input instanceof AcpSessionEditorInput ? input : undefined
  const session = acpInput ? service.getById(acpInput.sessionId) : undefined

  const [phase, setPhase] = useState<ResumePhase>({ kind: 'idle' })

  useEffect(() => {
    if (!acpInput || session) return
    if (phase.kind !== 'idle') return
    setPhase({ kind: 'pending' })
    service.resumeSession(acpInput.sessionId).then(
      () => {
        // 成功路径：service.sessions 的变更会驱动 useObservable 重渲，
        // 渲染分支自动切到 <ChatBody />，无需在此 setPhase。
      },
      (err: unknown) => {
        setPhase({ kind: 'error', message: (err as Error).message })
      },
    )
  }, [acpInput, service, session, phase.kind])

  if (!acpInput) return null

  if (session) return <ChatBody session={session} autoFocus />

  if (phase.kind === 'error') {
    return (
      <div className={styles['sessionLoading']} data-testid="acp-session-resume-error">
        <div className={styles['sessionLoadingHeader']}>
          <AlertCircle size={20} strokeWidth={1.75} aria-hidden="true" />
          <p className={styles['sessionLoadingMessage']}>
            {localize('acp.session.resumeFailed', 'Failed to resume agent session: {error}', {
              error: phase.message,
            })}
          </p>
        </div>
        <button
          type="button"
          className={styles['sessionRetryButton']}
          onClick={() => setPhase({ kind: 'idle' })}
          data-testid="acp-session-resume-retry"
        >
          <RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />
          {localize('acp.session.retry', 'Retry')}
        </button>
      </div>
    )
  }

  return (
    <div className={styles['sessionLoading']} data-testid="acp-session-resuming">
      <div className={styles['sessionLoadingHeader']}>
        <Loader2 size={20} strokeWidth={1.75} className={styles['spin']} aria-hidden="true" />
        <p className={styles['sessionLoadingMessage']}>
          {localize('acp.session.resuming', 'Resuming agent session...')}
        </p>
      </div>
    </div>
  )
}
