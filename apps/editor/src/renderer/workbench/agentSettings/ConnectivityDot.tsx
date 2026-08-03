/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConnectivityDot — a small status dot shown at the start of a saved-credential
 *  row in the agent settings panels. Green = the gateway answered an HTTP probe,
 *  gray = unreachable (or still checking). Shared by the Claude and Codex
 *  Authentication panels; each panel passes its own config service as `probe`.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { localize } from '@universe-editor/platform'
import styles from './AgentSettingsEditor.module.css'

export type ConnectivityProbe = (baseUrl: string) => Promise<boolean>

type State = 'checking' | 'ok' | 'fail'

export function ConnectivityDot({
  baseUrl,
  probe,
}: {
  /** Undefined for non-gateway credentials — renders a placeholder to keep rows aligned. */
  baseUrl: string | undefined
  probe: ConnectivityProbe
}) {
  const [state, setState] = useState<State>('checking')

  useEffect(() => {
    if (!baseUrl) return
    let active = true
    setState('checking')
    probe(baseUrl).then(
      (ok) => {
        if (active) setState(ok ? 'ok' : 'fail')
      },
      () => {
        if (active) setState('fail')
      },
    )
    return () => {
      active = false
    }
  }, [baseUrl, probe])

  if (!baseUrl) return <span className={styles['connDotPlaceholder']} aria-hidden="true" />

  const tooltip =
    state === 'ok'
      ? localize('agentSettings.connectivity.ok', 'Gateway reachable')
      : state === 'checking'
        ? localize('agentSettings.connectivity.checking', 'Checking connectivity…')
        : localize('agentSettings.connectivity.fail', 'Gateway unreachable')
  const className =
    state === 'ok'
      ? `${styles['connDot']} ${styles['connDotOk']}`
      : state === 'checking'
        ? `${styles['connDot']} ${styles['connDotChecking']}`
        : styles['connDot']
  return <span className={className} data-tooltip={tooltip} role="img" aria-label={tooltip} />
}
