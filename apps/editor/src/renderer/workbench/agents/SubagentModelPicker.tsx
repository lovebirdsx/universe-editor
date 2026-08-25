/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SubagentModelPicker — standalone trigger in the prompt action row of
 *  claude-code sessions: a compact "Sub Agent" pick over the selected
 *  provider's candidates, opened in an AnchoredSurface floating above the
 *  trigger with viewport avoidance (the old Model-popover footer scrolled out
 *  of view whenever the model candidate list was long).
 *
 *  The pick travels as CLAUDE_CODE_SUBAGENT_MODEL spawn env, so it only reaches
 *  a freshly spawned process; after the user changes it, a hint row appears and
 *  offers an inline restart of the agent process.
 *
 *  Rows are the effective env ids straight from settings.json — the same
 *  strings the spawned process receives — so the highlighted row cannot
 *  disagree with the model the sub-agents actually run.
 *
 *  `SubagentModelPanel` is the surface-free content (all logic included) so the
 *  overflow menu can render the same pick inline; the picker is just the
 *  trigger + anchored shell around it.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useRef, useState, type HTMLAttributes } from 'react'
import { ChevronDown, Users } from 'lucide-react'
import { INotificationService, Severity, localize } from '@universe-editor/platform'
import { AnchoredSurface } from '@universe-editor/workbench-ui'
import {
  candidateModelsForProtocol,
  CLAUDE_AGENT_PROTOCOL,
} from '../../services/acp/acpModelCandidates.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionService.js'
import { useClaudeConfig } from '../agentSettings/claude/useClaudeConfig.js'
import { useProviderRegistry } from '../agentSettings/useProviderRegistry.js'
import { useService } from '../useService.js'
import styles from './agents.module.css'

/** Inherit is the empty pick — `setSubagentModel(undefined)` clears the env. */
const INHERIT = ''

export function SubagentModelPicker({
  session,
  open,
  onOpen,
  onClose,
}: {
  session: IAcpSession
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const { subagentModelEnv } = useClaudeConfig()
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)

  const current = subagentModelEnv ?? INHERIT
  const triggerValue =
    current === INHERIT ? localize('acp.subagent.triggerInherit', 'Sub: inherit') : current
  const triggerTooltip = `${localize('acp.subagent.label', 'Sub Agent')}: ${
    current === INHERIT ? localize('acp.subagent.inherit', 'Follow main model') : current
  }`

  return (
    <div className={styles['configTriggerWrap']} data-testid="acp-subagent-picker">
      <button
        type="button"
        className={styles['configTrigger']}
        data-testid="acp-subagent-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={triggerTooltip}
        onMouseDown={(e) => {
          // The surface's outside-press listens on document mousedown; without
          // this the same click would dismiss and the click below would
          // immediately reopen the panel.
          e.stopPropagation()
        }}
        onClick={(e) => {
          if (open) {
            onClose()
            return
          }
          const rect = e.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.left, y: rect.top })
          onOpen()
        }}
      >
        <Users size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles['configTriggerValue']}>{triggerValue}</span>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && anchor !== null ? (
        <AnchoredSurface
          x={anchor.x}
          y={anchor.y}
          placement="top-start"
          offset={4}
          onClose={onClose}
          surfaceProps={
            {
              className: styles['subagentPanel'],
              role: 'listbox',
              'aria-label': localize('acp.subagent.label', 'Sub Agent'),
              'data-testid': 'acp-subagent-panel',
            } as HTMLAttributes<HTMLDivElement>
          }
        >
          <SubagentModelPanel session={session} />
        </AnchoredSurface>
      ) : null}
    </div>
  )
}

/** Surface-free pick content; renders inside any host (picker surface, overflow menu). */
export function SubagentModelPanel({ session }: { session: IAcpSession }) {
  const { activeAuth, subagentModelEnv, setSubagentModel } = useClaudeConfig()
  const { providers } = useProviderRegistry()
  const notifications = useService(INotificationService)
  // Silent until the user actually changes the value, so the picker stays
  // compact for everyone who only opened it to look.
  const [changed, setChanged] = useState(false)
  const pendingWrite = useRef<Promise<void> | undefined>(undefined)

  // Candidates come from the provider whose credential is actually in effect on
  // disk, not a separately stored selection that could disagree with it.
  const provider = useMemo(
    () =>
      activeAuth.kind === 'provider' && activeAuth.providerId !== undefined
        ? providers.find((p) => p.id === activeAuth.providerId)
        : undefined,
    [activeAuth, providers],
  )
  const candidates = useMemo(
    () => candidateModelsForProtocol(provider, CLAUDE_AGENT_PROTOCOL),
    [provider],
  )
  const current = subagentModelEnv ?? INHERIT
  // A value the provider no longer offers must stay selectable instead of
  // vanishing while it is still the one in effect.
  const options = useMemo(
    () =>
      current !== INHERIT && !candidates.includes(current) ? [current, ...candidates] : candidates,
    [candidates, current],
  )

  const pick = (value: string): void => {
    if (value === current) return
    // A superseded write is nobody's awaited promise anymore, so swallow its
    // rejection here or it surfaces as an unhandled rejection; the write that
    // wins is the one `restart` reports on.
    void pendingWrite.current?.catch(() => {})
    pendingWrite.current = setSubagentModel(value === INHERIT ? undefined : value)
    setChanged(true)
  }

  const restart = async (): Promise<void> => {
    // The sub-agent model is spawn env, so the fresh process reads it from
    // settings.json as it spawns — the pick must have landed on disk first.
    try {
      await pendingWrite.current
    } catch (err) {
      // Restarting on a failed write would spawn against the old value, which
      // looks like the restart silently did nothing.
      notifications.notify({
        severity: Severity.Error,
        message: localize('acp.subagent.writeFailed', 'Could not save the sub-agent model: {0}', {
          0: (err as Error).message,
        }),
      })
      return
    }
    session.requestProcessRestart()
    // The value is live on the restarted process now, so the "takes effect next
    // session" hint would be lying if it stayed up.
    pendingWrite.current = undefined
    setChanged(false)
  }

  const rows = [
    {
      key: INHERIT,
      value: INHERIT,
      label: localize('acp.subagent.inherit', 'Follow main model'),
      active: current === INHERIT,
    },
    ...options.map((m) => ({
      key: m,
      value: m,
      label: m,
      active: m === current,
    })),
  ]

  return (
    <>
      <div className={styles['configPopoverGroupLabel']}>
        {localize('acp.subagent.label', 'Sub Agent')}
      </div>
      <div className={styles['subagentPanelDesc']}>
        {localize(
          'acp.subagent.panelDesc',
          'Sub agents run with this model. It is read when they spawn, so changes apply from the next session.',
        )}
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          role="option"
          aria-selected={row.active}
          data-active={row.active}
          className={styles['configPopoverItem']}
          data-tooltip={row.label}
          onMouseDown={(e) => {
            e.preventDefault()
            pick(row.value)
          }}
        >
          <span className={styles['configPopoverItemName']}>{row.label}</span>
        </div>
      ))}
      {changed ? (
        <div className={styles['subagentPanelHint']}>
          {localize('acp.subagent.nextSession', 'Takes effect next session')} ·{' '}
          <button type="button" data-testid="acp-subagent-restart" onClick={() => void restart()}>
            {localize('acp.subagent.restartNow', 'Restart now')}
          </button>
        </div>
      ) : null}
    </>
  )
}
