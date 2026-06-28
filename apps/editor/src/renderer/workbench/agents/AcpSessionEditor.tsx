/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionEditor — full-screen editor variant of ChatBody. Looks the session
 *  up by id from the AcpSessionService; auto-resumes when the input refers to
 *  a session that exists in history but isn't live yet.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { AlertCircle, KeyRound, Loader2, RotateCw } from 'lucide-react'
import {
  ICommandService,
  IEditorInput,
  IEditorService,
  IWorkspaceService,
  IHostService,
  arePathsEqual,
  localize,
} from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { IAcpSessionHistoryService } from '../../services/acp/acpSessionHistory.js'
import type { AcpSessionHistoryEntry } from '../../services/acp/acpSessionHistory.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import { isAuthRequiredError } from '../../services/acp/acpAuthError.js'
import { ChatBody } from './ChatBody.js'
import { ForeignSessionPreview } from './ForeignSessionPreview.js'
import styles from './agents.module.css'

type ResumePhase =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'error'; message: string; needsAuth: boolean }

export function AcpSessionEditor({ input }: { input: IEditorInput }) {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const workspace = useService(IWorkspaceService)
  const hostService = useService(IHostService)
  useObservable(service.sessions)
  // 订阅 history 是为了让水化完成时触发重渲，让一个尚未 resume 的 session 在 history
  // 条目到位后能被重新评估。
  useObservable(history.entries)

  const acpInput = input instanceof AcpSessionEditorInput ? input : undefined
  const session = acpInput ? service.getById(acpInput.sessionId) : undefined

  if (!acpInput) return null

  if (session) {
    return <ChatBody session={session} readOnly={session.readOnly} autoFocus={!session.readOnly} />
  }

  // A session whose cwd differs from the open folder must not be resumed live —
  // that would spawn the agent against a sibling worktree behind this window's
  // UI. Instead resume it READ-ONLY (replay history via session/load, no prompt /
  // config side effects) so the user can read the conversation; on failure
  // (e.g. agent without loadSession) fall back to the metadata-only preview.
  const entry = history.get(acpInput.sessionId)
  const currentCwd = workspace.current?.folder.fsPath
  const isForeign =
    entry?.cwd !== undefined &&
    currentCwd !== undefined &&
    !arePathsEqual(entry.cwd, currentCwd, hostService.platform)
  if (entry && isForeign) {
    return <ForeignSessionResumer key={acpInput.sessionId} input={acpInput} entry={entry} />
  }

  // EditorGroupView 用 `<Component input={active} />`（无 key）渲染激活编辑器，切换 tab
  // 会复用同一个 AcpSessionEditor 实例、只换 input prop。若把 resume 的 phase 状态直接
  // 挂在这里，phase 会跨 input 残留——一旦它停在 'pending'（首个 session resume 后从不
  // 复位），`phase !== 'idle'` 守卫会永久挡住下一个 session 的 resume，表现为切到第二个
  // 会话永远转圈、不发 session/load、也不报错。用 sessionId 作 key 让每个会话拥有独立
  // 的 resume 状态机即可根治。
  return <AcpSessionResumer key={acpInput.sessionId} input={acpInput} />
}

/**
 * Read-only resume of a session that belongs to another worktree: kicks off
 * `resumeSessionReadOnly`, shows a loading header while the agent replays the
 * conversation, then re-renders into the read-only ChatBody once the session is
 * registered (the parent's `useObservable(service.sessions)` picks it up and the
 * `getById` branch above takes over). If the read-only resume fails — e.g. the
 * agent does not support `session/load` — we fall back to the metadata-only
 * preview so activation is still reachable.
 */
function ForeignSessionResumer({
  input,
  entry,
}: {
  input: AcpSessionEditorInput
  entry: AcpSessionHistoryEntry
}) {
  const service = useService(IAcpSessionService)
  const sessionId = input.sessionId
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    service.resumeSessionReadOnly(sessionId).then(
      () => {
        // Success: service.sessions changes → parent re-renders → getById hits →
        // <ChatBody readOnly>. Nothing to do here.
      },
      () => {
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [service, sessionId])

  if (failed) {
    return <ForeignSessionPreview key={sessionId} entry={entry} />
  }

  return (
    <div className={styles['sessionLoading']} data-testid="acp-foreign-session-loading">
      <div className={styles['sessionLoadingHeader']}>
        <Loader2 size={20} strokeWidth={1.75} className={styles['spin']} aria-hidden="true" />
        <p className={styles['sessionLoadingMessage']}>
          {localize('acp.foreignSession.loading', 'Loading session history (read-only)...')}
        </p>
      </div>
    </div>
  )
}

function AcpSessionResumer({ input }: { input: AcpSessionEditorInput }) {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const editor = useService(IEditorService)
  const commands = useService(ICommandService)
  const sessionId = input.sessionId
  const [phase, setPhase] = useState<ResumePhase>({ kind: 'idle' })

  useEffect(() => {
    if (phase.kind !== 'idle') return
    setPhase({ kind: 'pending' })
    service.resumeSession(sessionId).then(
      () => {
        // 成功路径：service.sessions 的变更驱动父组件 useObservable 重渲，渲染分支自动
        // 切到 <ChatBody />（本组件随即卸载），无需在此 setPhase。
      },
      (err: unknown) => {
        // 若 session 已从 history 消失，说明它是一个「创建了但从未发过消息」的空会话：
        // 重启后 agent 没能恢复它，已被静默丢弃。此时不显示加载失败，直接关闭本 tab。
        // 真正的失败（agent 崩溃等）会保留 history 条目 → 落到下面的 error 分支并提供重试。
        if (history.get(sessionId) === undefined) {
          editor.closeEditor(input.id)
          return
        }
        setPhase({
          kind: 'error',
          message: (err as Error).message,
          needsAuth: isAuthRequiredError(err),
        })
      },
    )
  }, [service, history, editor, input, sessionId, phase.kind])

  if (phase.kind === 'error') {
    return (
      <div className={styles['sessionLoading']} data-testid="acp-session-resume-error">
        <div className={styles['sessionLoadingHeader']}>
          <AlertCircle size={20} strokeWidth={1.75} aria-hidden="true" />
          <p className={styles['sessionLoadingMessage']}>
            {phase.needsAuth
              ? localize(
                  'acp.session.authRequired',
                  'This agent needs authentication before it can start.',
                )
              : localize('acp.session.resumeFailed', 'Failed to resume agent session: {error}', {
                  error: phase.message,
                })}
          </p>
        </div>
        {phase.needsAuth && (
          <button
            type="button"
            className={styles['sessionRetryButton']}
            onClick={() => void commands.executeCommand('workbench.action.agent.openSettings')}
            data-testid="acp-session-open-auth"
          >
            <KeyRound size={14} strokeWidth={1.75} aria-hidden="true" />
            {localize('acp.session.openAuth', 'Open Agent Settings')}
          </button>
        )}
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
