/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SubagentModelPicker — standalone trigger in the prompt action row of
 *  claude-code sessions: a compact "Sub Agent" pick over the session's live
 *  model catalogue (official Anthropic models + gateway extraModels) merged
 *  with the selected provider's protocolMap candidates, opened in an
 *  AnchoredSurface floating above the trigger with viewport avoidance (the old
 *  Model-popover footer scrolled out of view whenever the model candidate list
 *  was long).
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
 *  trigger + anchored shell around it. The panel owns its own list navigation:
 *  when it renders inside the overflow panel it is the inner region, and the
 *  `onExitUp` / `onExitDown` hooks let its cursor fall back out to the rows.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useRef, useState, type HTMLAttributes } from 'react'
import { Users } from 'lucide-react'
import { INotificationService, Severity, localize } from '@universe-editor/platform'
import { AnchoredSurface, useOverlayListNavigation } from '@universe-editor/workbench-ui'
import {
  candidateModelsForProtocol,
  CLAUDE_AGENT_PROTOCOL,
  mergeModelCandidates,
  sessionModelCandidates,
} from '../../services/acp/acpModelCandidates.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionService.js'
import { useClaudeConfig } from '../agentSettings/claude/useClaudeConfig.js'
import { useProviderRegistry } from '../agentSettings/useProviderRegistry.js'
import { useObservable, useService } from '../useService.js'
import { ConfigTrigger, type ConfigBarAnchor } from './ConfigOptionsBar.js'
import styles from './agents.module.css'

/** Inherit is the empty pick — `setSubagentModel(undefined)` clears the env. */
const INHERIT = ''

export function SubagentModelPicker({
  session,
  open,
  anchor,
  onRequestOpen,
  onClose,
  onEscape,
  onAltDigit,
}: {
  session: IAcpSession
  open: boolean
  anchor: ConfigBarAnchor | null
  onRequestOpen: (trigger: HTMLElement) => void
  onClose: () => void
  onEscape: () => boolean
  onAltDigit: (digit: number) => void
}) {
  const { subagentModelEnv } = useClaudeConfig()

  const current = subagentModelEnv ?? INHERIT
  const triggerValue =
    current === INHERIT ? localize('acp.subagent.triggerInherit', 'Sub: inherit') : current
  const triggerTooltip = `${localize('acp.subagent.label', 'Sub Agent')}: ${
    current === INHERIT ? localize('acp.subagent.inherit', 'Follow main model') : current
  }`

  return (
    <div className={styles['configTriggerWrap']} data-testid="acp-subagent-picker">
      <ConfigTrigger
        testId="acp-subagent-picker-trigger"
        icon={<Users size={13} strokeWidth={1.75} aria-hidden="true" />}
        value={triggerValue}
        tooltip={triggerTooltip}
        hasPopup="listbox"
        open={open}
        onRequestOpen={onRequestOpen}
        onClose={onClose}
      />
      {open && anchor !== null ? (
        <AnchoredSurface
          x={anchor.x}
          y={anchor.y}
          placement="top-start"
          offset={4}
          onClose={onClose}
          onEscape={onEscape}
          surfaceProps={
            {
              className: styles['subagentPanel'],
              'data-testid': 'acp-subagent-panel',
            } as HTMLAttributes<HTMLDivElement>
          }
        >
          <SubagentModelPanel session={session} onAltDigit={onAltDigit} />
        </AnchoredSurface>
      ) : null}
    </div>
  )
}

/** Surface-free pick content; renders inside any host (picker surface, overflow menu). */
export function SubagentModelPanel({
  session,
  onAltDigit,
  onExitUp,
  onExitDown,
}: {
  session: IAcpSession
  onAltDigit?: (digit: number) => void
  onExitUp?: () => void
  onExitDown?: () => void
}) {
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
  // The session's live model list is the fork's own catalogue — official
  // Anthropic models plus the gateway extraModels injected at handshake — so
  // the sub-agent pick offers the same scope as the main model picker, including
  // official-subscription credentials where there is no provider entry at all.
  // The protocolMap declaration merges in behind it: it covers the window
  // before the config bag arrives (and the no-model-option fallback) without
  // duplicating rows once the session list is live.
  const configOptions = useObservable(session.configOptions)
  const candidates = useMemo(
    () =>
      mergeModelCandidates(
        sessionModelCandidates(configOptions),
        candidateModelsForProtocol(provider, CLAUDE_AGENT_PROTOCOL),
      ),
    [configOptions, provider],
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

  const rows = useMemo(
    () => [
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
    ],
    [options, current],
  )

  const listLabel = localize('acp.subagent.label', 'Sub Agent')
  const nav = useOverlayListNavigation({
    count: rows.length,
    initialIndex: rows.findIndex((r) => r.active),
    onActivate: (index) => {
      const row = rows[index]
      if (row) pick(row.value)
    },
    getTypeaheadText: (index) => rows[index]?.label ?? '',
    // Nested in the overflow panel the ends are exits — the cursor falls back
    // out to the rows rather than jumping to the other extreme; standalone it
    // wraps like every other picker.
    wrap: onExitUp === undefined && onExitDown === undefined,
    ariaLabel: listLabel,
    ...(onAltDigit !== undefined ? { onAltDigit } : {}),
    ...(onExitUp !== undefined ? { onExitUp } : {}),
    ...(onExitDown !== undefined ? { onExitDown } : {}),
  })

  return (
    // The heading, the description and the restart hint are not options, so the
    // listbox sits on a wrapper that holds nothing but the rows (the focus host
    // itself stays unroled — a listbox may only contain options).
    <div ref={nav.containerRef} {...nav.containerProps} role={undefined} aria-label={undefined}>
      <div className={styles['configPopoverGroupLabel']}>
        {localize('acp.subagent.label', 'Sub Agent')}
      </div>
      <div className={styles['subagentPanelDesc']}>
        {localize(
          'acp.subagent.panelDesc',
          'Sub agents run with this model. It is read when they spawn, so changes apply from the next session.',
        )}
      </div>
      <div role="listbox" aria-label={listLabel}>
        {rows.map((row, index) => (
          <div
            key={row.key}
            {...nav.getItemProps(index)}
            className={styles['configPopoverItem']}
            data-current={row.active ? 'true' : undefined}
            data-tooltip={row.label}
          >
            <span className={styles['configPopoverItemName']}>{row.label}</span>
          </div>
        ))}
      </div>
      {changed ? (
        <div className={styles['subagentPanelHint']}>
          {localize('acp.subagent.nextSession', 'Takes effect next session')} ·{' '}
          <button type="button" data-testid="acp-subagent-restart" onClick={() => void restart()}>
            {localize('acp.subagent.restartNow', 'Restart now')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
