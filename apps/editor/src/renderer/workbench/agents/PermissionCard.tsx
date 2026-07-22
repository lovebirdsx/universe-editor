/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PermissionCard — renders the active session's pending permission request
 *  inline above the prompt input. Multi-session friendly: a stuck card on one
 *  session doesn't block traffic on another.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { localize } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import styles from './agents.module.css'

export function PermissionCard({ session }: { session: IAcpSession }) {
  const pending = useObservable(session.pendingPermission)
  const [steer, setSteer] = useState('')

  if (!pending) return null

  const allowOnce = pending.options.find((o) => o.kind === 'allow_once')
  const allowAlways = pending.options.find((o) => o.kind === 'allow_always')
  const reject = pending.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always')

  // ExitPlanMode（"Ready to code?"）额外提供一个自由输入框：用户直接写下对计划的
  // 意见，无需先 Dismiss 再回到输入框。提交时走 "keep planning" 的 reject 分支，并把
  // 意见作为 feedback 一并回传——fork 会将其作为被拒工具的 deny message 反馈给 agent。
  // 这样它落盘为可回放的 tool_result（而非会话结束即丢失的 queued_command），回放可见。
  const isPlanReview = pending.kind === 'switch_mode'

  const submitSteer = (): void => {
    const text = steer.trim()
    if (text.length === 0) return
    if (reject) pending.resolve(reject.optionId, text)
    else pending.cancel()
    setSteer('')
  }

  return (
    <section className={styles['permissionCard']} data-testid="acp-permission-card">
      <header className={styles['permissionHeader']}>
        <span className={styles['permissionTitle']}>{pending.title}</span>
        {pending.kind && <span className={styles['permissionKind']}>{pending.kind}</span>}
      </header>
      <div className={styles['permissionActions']}>
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
        {allowAlways && (
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
