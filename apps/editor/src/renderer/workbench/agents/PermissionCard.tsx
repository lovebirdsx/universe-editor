/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PermissionCard — renders the active session's pending permission request
 *  inline above the prompt input. Multi-session friendly: a stuck card on one
 *  session doesn't block traffic on another.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { localize } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import type {
  AcpPendingPermission,
  IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
import { PlanAutoExecuteToggle } from './PlanAutoExecuteToggle.js'
import styles from './agents.module.css'

export function PermissionCard({ session }: { session: IAcpSession }) {
  const pending = useObservable(session.pendingPermission)
  if (!pending) return null
  // key 强制每个新请求整体重挂载：倒计时与开关镜像 state 以单个请求为生命周期。
  return <ActivePermissionCard key={pending.toolCallId} pending={pending} />
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

  // 本次请求的自动执行倒计时（service 按设置附加 autoResolve；选项缺席时为 undefined）。
  // hover / 聚焦卡片即暂停，取消勾选开关同时作废本次倒计时。
  const auto = pending.autoResolve
  const [autoCancelled, setAutoCancelled] = useState(false)
  const autoActive = !!auto && !autoCancelled
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const [displayMs, setDisplayMs] = useState(auto?.delayMs ?? 0)
  const remainingRef = useRef(auto?.delayMs ?? 0)

  useEffect(() => {
    if (!auto || !autoActive || paused) return
    const deadline = Date.now() + remainingRef.current
    const timer = setTimeout(() => pending.resolve(auto.optionId), remainingRef.current)
    const ticker = setInterval(() => {
      remainingRef.current = Math.max(0, deadline - Date.now())
      setDisplayMs(remainingRef.current)
    }, 200)
    return () => {
      clearTimeout(timer)
      clearInterval(ticker)
      remainingRef.current = Math.max(0, deadline - Date.now())
    }
  }, [auto, autoActive, paused, pending])

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
        {/* plan 审查卡把 allow_always（bypass）放首位，对齐 CLI 的 plan 退出对话与
            fork 的 options 顺序——它是绝大多数用户的选择；普通工具卡保持最小授权
            （allow_once）在前的保守顺序。 */}
        {isPlanReview && allowAlways && (
          <button
            type="button"
            className={styles['permissionAllow']}
            onClick={() => pending.resolve(allowAlways.optionId)}
            data-testid="acp-permission-allow-always"
          >
            {allowAlways.name}
          </button>
        )}
        {allowOnce && (
          <button
            type="button"
            className={styles['permissionAllow']}
            onClick={() => pending.resolve(allowOnce.optionId)}
            data-testid="acp-permission-allow-once"
          >
            {allowOnce.name}
          </button>
        )}
        {!isPlanReview && allowAlways && (
          <button
            type="button"
            className={styles['permissionAllow']}
            onClick={() => pending.resolve(allowAlways.optionId)}
            data-testid="acp-permission-allow-always"
          >
            {allowAlways.name}
          </button>
        )}
        {reject && (
          <button
            type="button"
            className={styles['permissionDeny']}
            onClick={() => pending.resolve(reject.optionId)}
            data-testid="acp-permission-deny"
          >
            {reject.name}
          </button>
        )}
        <button
          type="button"
          className={styles['permissionDeny']}
          onClick={() => pending.cancel()}
          data-testid="acp-permission-cancel"
        >
          Dismiss
        </button>
      </div>
      {isPlanReview && (
        <div className={styles['permissionAuto']}>
          <PlanAutoExecuteToggle onUnchecked={() => setAutoCancelled(true)} />
          {autoActive && auto && (
            <span
              className={styles['permissionAutoCountdown']}
              title={autoOptionName}
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
      {isPlanReview && (
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
