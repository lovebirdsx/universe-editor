/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PermissionCard — renders the active session's pending permission request
 *  inline above the prompt input. Multi-session friendly: a stuck card on one
 *  session doesn't block traffic on another.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { localize, observableValue } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import type {
  AcpAutoResolveState,
  AcpPendingPermission,
  IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
import { supportsPlanReviewFeedback } from '../../services/acp/session/planAutoExecute.js'
import { PlanAutoExecuteToggle } from './PlanAutoExecuteToggle.js'
import styles from './agents.module.css'

/** Placeholder for cards without a countdown; keeps the hook call unconditional. */
const NO_AUTO_RESOLVE_STATE = observableValue<AcpAutoResolveState>(
  'acp.permission.autoResolve.none',
  { paused: false, remainingMs: 0, cancelled: true },
)

export function PermissionCard({ session }: { session: IAcpSession }) {
  const pending = useObservable(session.pendingPermission)
  if (!pending) return null
  // key 强制每个新请求整体重挂载：steering 输入框以单个请求为生命周期。
  return <ActivePermissionCard key={pending.requestId} pending={pending} />
}

function ActivePermissionCard({ pending }: { pending: AcpPendingPermission }) {
  const [steer, setSteer] = useState('')

  const allowOnce = pending.options.find((o) => o.kind === 'allow_once')
  const allowAlways = pending.options.find((o) => o.kind === 'allow_always')
  const reject = pending.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always')

  // ExitPlanMode（"Ready to code?"）额外提供一个自由输入框：用户直接写下对计划的
  // 意见，无需先 Dismiss 再回到输入框。提交时走 "keep planning" 的 reject 分支，并把
  // 意见作为 feedback 一并回传——fork 会将其作为被拒工具的 deny message 反馈给 agent。
  // 这样它落盘为可回放的 tool_result（而非会话结束即丢失的 queued_command），回放可见。
  const isPlanReview = pending.kind === 'switch_mode'
  const options = isPlanReview
    ? pending.options
    : [allowOnce, allowAlways, reject].filter((option) => option !== undefined)
  // codex 的计划审查卡只认 optionId、不读 `_meta.feedback`：意见会被静默丢弃，不渲染输入框。
  const showSteer = isPlanReview && supportsPlanReviewFeedback(pending.options)

  // 倒计时归 service 所有（会话 tab 未挂载也照常执行）；卡片只读取快照并
  // 在 hover / 聚焦时暂停、取消勾选时作废，绝不再自己 setTimeout 结算。
  const auto = pending.autoResolve
  const autoState = useObservable(auto?.state ?? NO_AUTO_RESOLVE_STATE)
  const autoActive = !!auto && !autoState.cancelled
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const [displayMs, setDisplayMs] = useState(0)

  useEffect(() => {
    if (!auto) return
    if (paused) auto.pause()
    else auto.resume()
    // Unmounting the card (session tab switched away) must not leave the timer
    // paused — the countdown keeps running in the service.
    return () => auto.resume()
  }, [auto, paused])

  useEffect(() => {
    const update = (): void => {
      setDisplayMs(
        autoState.deadlineAt !== undefined
          ? Math.max(0, autoState.deadlineAt - Date.now())
          : autoState.remainingMs,
      )
    }
    update()
    if (autoState.cancelled || autoState.deadlineAt === undefined) return
    const ticker = setInterval(update, 200)
    return () => clearInterval(ticker)
  }, [autoState])

  const submitSteer = (): void => {
    const text = steer.trim()
    if (text.length === 0) return
    if (reject) pending.resolve(reject.optionId, text)
    else pending.cancel()
    setSteer('')
  }

  const autoOptionName = auto
    ? pending.options.find((o) => o.optionId === auto.optionId)?.name
    : undefined

  return (
    <section
      className={styles['permissionCard']}
      data-testid="acp-permission-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <header className={styles['permissionHeader']}>
        <span className={styles['permissionTitle']}>{pending.title}</span>
        {pending.kind && <span className={styles['permissionKind']}>{pending.kind}</span>}
      </header>
      <div className={styles['permissionActions']}>
        {options.map((option) => {
          const allowed = option.kind === 'allow_once' || option.kind === 'allow_always'
          return (
            <button
              key={option.optionId}
              type="button"
              className={styles[allowed ? 'permissionAllow' : 'permissionDeny']}
              onClick={() => pending.resolve(option.optionId)}
              data-option-id={option.optionId}
              data-testid={
                allowed
                  ? `acp-permission-${option.kind === 'allow_once' ? 'allow-once' : 'allow-always'}`
                  : 'acp-permission-deny'
              }
            >
              {option.name}
            </button>
          )
        })}
        <button
          type="button"
          className={styles['permissionDeny']}
          onClick={() => pending.cancel()}
          data-testid="acp-permission-cancel"
        >
          {localize('common.dismiss', 'Dismiss')}
        </button>
      </div>
      {isPlanReview && (
        <div className={styles['permissionAuto']}>
          <PlanAutoExecuteToggle onUnchecked={() => auto?.cancel()} />
          {autoActive && auto && (
            <span
              className={styles['permissionAutoCountdown']}
              data-tooltip={autoOptionName}
              data-testid="acp-permission-auto-countdown"
            >
              {localize('acp.permission.autoExecute.countdown', 'auto-executing in {secs}s', {
                secs: String(Math.ceil(displayMs / 1000)),
              })}
            </span>
          )}
          {autoActive && auto && (
            <div className={styles['permissionAutoProgress']} aria-hidden="true">
              <div style={{ width: `${(displayMs / auto.delayMs) * 100}%` }} />
            </div>
          )}
        </div>
      )}
      {showSteer && (
        <div className={styles['permissionSteer']}>
          <textarea
            className={styles['questionFreeform']}
            value={steer}
            spellCheck={false}
            rows={1}
            placeholder={localize(
              'acp.permission.steer.placeholder',
              'Tell Claude what to do instead…',
            )}
            onChange={(e) => setSteer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitSteer()
              }
            }}
            data-testid="acp-permission-steer-input"
          />
          <button
            type="button"
            className={styles['permissionAllow']}
            disabled={steer.trim().length === 0}
            onClick={submitSteer}
            data-testid="acp-permission-steer-submit"
          >
            {localize('acp.permission.steer.submit', 'Send')}
          </button>
        </div>
      )}
    </section>
  )
}
