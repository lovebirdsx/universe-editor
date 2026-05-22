/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PermissionCard — renders the active session's pending permission request
 *  inline above the prompt input. Multi-session friendly: a stuck card on one
 *  session doesn't block traffic on another.
 *--------------------------------------------------------------------------------------------*/

import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import styles from './agents.module.css'

export function PermissionCard({ session }: { session: IAcpSession }) {
  const pending = useObservable(session.pendingPermission)
  if (!pending) return null

  const allowOnce = pending.options.find((o) => o.kind === 'allow_once')
  const allowAlways = pending.options.find((o) => o.kind === 'allow_always')
  const reject = pending.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always')

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
    </section>
  )
}
