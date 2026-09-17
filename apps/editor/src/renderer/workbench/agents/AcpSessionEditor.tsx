/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionEditor — the session editor tab: hosts ChatBody. Looks the session
 *  up by id from the AcpSessionService; auto-resumes when the input refers to
 *  a session that exists in history but isn't live yet.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, KeyRound, Loader2, RotateCw } from 'lucide-react'
import {
  ICommandService,
  IEditorInput,
  IEditorService,
  IWindowsService,
  IWorkspaceService,
  IUriIdentityService,
  REMOTE_SCHEME,
  localize,
} from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  isForeignWorkspaceSession,
} from '../../services/acp/session/acpSessionHistory.js'
import type { AcpSessionHistoryEntry } from '../../services/acp/session/acpSessionHistory.js'
import { AcpSessionEditorInput } from '../../services/acp/session/acpSessionEditorInput.js'
import { isAuthRequiredError } from '../../services/acp/session/acpAuthError.js'
import { shouldPauseAcpAutoResume } from '../../services/acp/session/acpAutoResumeGuard.js'
import { formatAcpErrorMessage } from '../../services/acp/session/acpErrorClassify.js'
import { ChatBody } from './ChatBody.js'
import { ForeignSessionPreview } from './ForeignSessionPreview.js'
import styles from './agents.module.css'

type ResumePhase =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'paused' }
  | { kind: 'error'; message: string; needsAuth: boolean }

export function AcpSessionEditor({ input }: { input: IEditorInput }) {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const workspace = useService(IWorkspaceService)
  const uriIdentity = useService(IUriIdentityService)
  useObservable(service.sessions)
  // 订阅 history 是为了让水化完成时触发重渲，让一个尚未 resume 的 session 在 history
  // 条目到位后能被重新评估。
  useObservable(history.entries)

  const acpInput = input instanceof AcpSessionEditorInput ? input : undefined
  const session = acpInput ? service.getById(acpInput.sessionId) : undefined
  // Resume phase lives here, not in AcpSessionResumer: `_resumeSessionInner` registers
  // the session before `session/load` finishes, so this component briefly renders
  // ChatBody and unmounts the Resumer. If load then fails, the store removes the
  // session and a fresh idle Resumer would auto-kick again (dozens of session/load
  // calls in seconds). Keep phase keyed by sessionId so tab switches cannot leak
  // a pending machine onto the next input. Only a resolved resume resets to idle.
  const [phaseBySessionId, setPhaseBySessionId] = useState<Record<string, ResumePhase>>({})
  const setPhaseFor = useCallback((id: string, next: ResumePhase) => {
    setPhaseBySessionId((prev) => ({ ...prev, [id]: next }))
  }, [])

  if (!acpInput) return null

  if (session) {
    return <ChatBody session={session} readOnly={session.readOnly} autoFocus={!session.readOnly} />
  }

  // A session from another workspace / worktree / remote host must not be resumed
  // live — that would spawn the agent against a different workspace behind this
  // window's UI. A subdirectory of the open folder is the same workspace and still
  // resumes live. For a truly foreign session resume READ-ONLY (replay history via
  // session/load, no prompt / config side effects) so the user can read the
  // conversation; on failure (e.g. agent without loadSession) fall back to the
  // metadata-only preview.
  const entry = history.get(acpInput.sessionId)
  // cwd 可能是远端 POSIX 路径；authority 才是跨主机判据（对齐 AcpSessionService._currentAuthority）。
  const folder = workspace.current?.folder
  const currentCwd = folder?.fsPath
  const currentAuthority =
    folder && folder.scheme === REMOTE_SCHEME ? folder.authority || undefined : undefined
  const isForeign =
    entry !== undefined &&
    isForeignWorkspaceSession(entry, currentCwd, currentAuthority, uriIdentity)
  if (entry && isForeign) {
    return <ForeignSessionResumer key={acpInput.sessionId} input={acpInput} entry={entry} />
  }

  // EditorGroupView 用 `<Component input={active} />`（无 key）渲染激活编辑器，切换 tab
  // 会复用同一个 AcpSessionEditor 实例、只换 input prop。phase 按 sessionId 分桶，Resumer
  // 仍用 sessionId 作 key（本地 ref / effect 隔离）。成功路径把该 id 复位为 idle，关闭
  // 后再打开才能再次 auto-resume；失败保持 error，直到用户点 Retry。
  const phase = phaseBySessionId[acpInput.sessionId] ?? { kind: 'idle' }
  return (
    <AcpSessionResumer
      key={acpInput.sessionId}
      input={acpInput}
      phase={phase}
      onPhaseChange={setPhaseFor}
    />
  )
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

function AcpSessionResumer({
  input,
  phase,
  onPhaseChange,
}: {
  input: AcpSessionEditorInput
  phase: ResumePhase
  onPhaseChange: (sessionId: string, next: ResumePhase) => void
}) {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const editor = useService(IEditorService)
  const commands = useService(ICommandService)
  const windows = useService(IWindowsService)
  const sessionId = input.sessionId
  const setPhase = (next: ResumePhase) => onPhaseChange(sessionId, next)
  // Set when the user clicks "load anyway" on the OOM-paused placeholder — the
  // guard must not re-pause the manual retry.
  const resumeAnywayRef = useRef(false)

  useEffect(() => {
    if (phase.kind !== 'idle') return
    let cancelled = false
    const kick = () => {
      setPhase({ kind: 'pending' })
      service.resumeSession(sessionId).then(
        () => {
          // Reset even if this Resumer already unmounted (parent swapped to
          // ChatBody after the brief pre-load register). Idle lets a later
          // close-and-reopen auto-resume; do not idle merely because a session
          // appeared — that happens before loadSession settles.
          onPhaseChange(sessionId, { kind: 'idle' })
        },
        (err: unknown) => {
          // 此处不查 cancelled：kick 里的 setPhase(pending) 改变 phase.kind 依赖，
          // effect 立即重跑并 cancel 掉发起 resume 的那个闭包——失败处理必须照常
          // 执行，否则 resume 失败的 tab 会永远停在 spinner 上。
          // 若 session 已从 history 消失，说明它是一个「创建了但从未发过消息」的空会话：
          // 重启后 agent 没能恢复它，已被静默丢弃。此时不显示加载失败，直接关闭本 tab。
          // 真正的失败（agent 崩溃等）会保留 history 条目 → 落到下面的 error 分支并提供重试。
          if (history.get(sessionId) === undefined) {
            editor.closeEditor(input.id)
            return
          }
          onPhaseChange(sessionId, {
            kind: 'error',
            message: formatAcpErrorMessage(err),
            needsAuth: isAuthRequiredError(err),
          })
        },
      )
    }
    if (resumeAnywayRef.current) {
      kick()
      return
    }
    // Crash-loop guard: if this window's renderer just died of OOM (typically
    // while replaying a huge history), don't immediately re-trigger the same
    // replay — park on a paused placeholder until the user asks to continue.
    shouldPauseAcpAutoResume(windows).then((pause) => {
      if (cancelled) return
      if (pause) setPhase({ kind: 'paused' })
      else kick()
    })
    return () => {
      cancelled = true
    }
  }, [service, history, editor, windows, input, sessionId, phase.kind, onPhaseChange])

  if (phase.kind === 'paused') {
    return (
      <div className={styles['sessionLoading']} data-testid="acp-session-resume-paused">
        <div className={styles['sessionLoadingHeader']}>
          <AlertCircle size={20} strokeWidth={1.75} aria-hidden="true" />
          <p className={styles['sessionLoadingMessage']}>
            {localize(
              'acp.session.resumePausedAfterOom',
              'Automatic resume is paused because this window ran out of memory while loading this session last time.',
            )}
          </p>
        </div>
        <button
          type="button"
          className={styles['sessionRetryButton']}
          onClick={() => {
            resumeAnywayRef.current = true
            setPhase({ kind: 'idle' })
          }}
          data-testid="acp-session-resume-anyway"
        >
          <RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />
          {localize('acp.session.resumeAnyway', 'Load Anyway')}
        </button>
      </div>
    )
  }

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
