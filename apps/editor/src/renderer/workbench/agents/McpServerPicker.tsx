/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  McpServerPicker — session-level MCP server toggle living in the prompt
 *  action row next to the config options. The trigger shows the effective
 *  "enabled / pool" count; the popover lists the union pool (extension
 *  contributions + `acp.mcpServers` settings + agent-owned config files —
 *  `~/.claude.json` / `~/.claude/settings.json`, `~/.codex/config.toml` — +
 *  project `.mcp.json` / `.codex/config.toml`) narrowed to the session's
 *  agent, each row with a checkbox, the live connection status dot, and its
 *  source. Toggling converges the session
 *  via IAcpSessionService.setSessionMcpServers (seamless reload) and affects
 *  only this session — the default set new sessions start with is governed by
 *  each entry's per-server default switch (`disabled` flag), editable inline
 *  via the "default" toggle and in AI Settings.
 *
 *  `McpPickerPanel` is the surface-free content (all logic included) so the
 *  overflow menu can render the same list inline; the picker is just the
 *  trigger + anchored shell around it.
 *--------------------------------------------------------------------------------------------*/

import { Plug } from 'lucide-react'
import type { HTMLAttributes } from 'react'
import { localize, ICommandService } from '@universe-editor/platform'
import { AnchoredSurface, useOverlayListNavigation } from '@universe-editor/workbench-ui'
import { useObservable, useOptionalService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../services/acp/session/acpSessionService.js'
import {
  agentIdToMcpAffinity,
  resolveMcpServerSelection,
  type McpServerDefinition,
} from '../../services/acp/acpMcpServers.js'
import { ConfigTrigger, type ConfigBarAnchor } from './ConfigOptionsBar.js'
import { McpEnablementToggles } from './McpEnablementToggles.js'
import styles from './agents.module.css'

/**
 * The picker (inline trigger and overflow row alike) self-hides for read-only
 * sessions — they cannot mutate the session's server set — and when the pool
 * is empty (nothing to toggle). Shared so the two hosts never drift apart.
 */
export function isMcpPickerHidden(
  session: IAcpSession,
  pool: readonly McpServerDefinition[],
): boolean {
  return session.readOnly || pool.length === 0
}

/**
 * Narrow the union pool mirror to what THIS session can actually wire: shared
 * definitions plus the ones whose `agentAffinity` matches the session's agent
 * (a definition without an affinity is shared). The mirror is the union across
 * agents so the AI settings panel can badge every source; a claude-code
 * session must neither display nor pin a codex-only entry — the wire filter
 * would silently drop it and the pinned name could never come back.
 * `sharedWith` rows stay visible for every agent that defines the name: the
 * union shows one row per name, so without this a codex+claude shared name
 * would vanish from the loser's picker even though its layers do wire it.
 */
export function filterPoolForSession(
  pool: readonly McpServerDefinition[],
  agentId: string | undefined,
): readonly McpServerDefinition[] {
  const affinity = agentIdToMcpAffinity(agentId)
  return pool.filter(
    (d) =>
      d.agentAffinity === undefined ||
      d.agentAffinity === affinity ||
      (affinity !== undefined && d.sharedWith?.includes(affinity) === true),
  )
}

export function McpServerPicker({
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
  // Soft dependency: unit tests render the config bar with a minimal DI
  // container that has no ACP layer — the picker simply stays absent there.
  const service = useOptionalService(IAcpSessionService)
  if (!service) return null
  return (
    <McpServerPickerInner
      session={session}
      service={service}
      open={open}
      anchor={anchor}
      onRequestOpen={onRequestOpen}
      onClose={onClose}
      onEscape={onEscape}
      onAltDigit={onAltDigit}
    />
  )
}

function McpServerPickerInner({
  session,
  service,
  open,
  anchor,
  onRequestOpen,
  onClose,
  onEscape,
  onAltDigit,
}: {
  session: IAcpSession
  service: IAcpSessionServiceType
  open: boolean
  anchor: ConfigBarAnchor | null
  onRequestOpen: (trigger: HTMLElement) => void
  onClose: () => void
  onEscape: () => boolean
  onAltDigit: (digit: number) => void
}) {
  const unionPool = useObservable(service.mcpServerDefinitions)
  const pool = filterPoolForSession(unionPool, session.agentId)
  const selection = useObservable(session.mcpServerSelection)
  if (isMcpPickerHidden(session, unionPool)) return null
  // `null` (inherit) resolves to every non-disabled pool entry — the same
  // default set a brand-new session starts with.
  const { enabledNames } = resolveMcpServerSelection(pool, selection)
  const enabledSet = new Set(enabledNames)
  const custom = selection !== null
  return (
    <div className={styles['configTriggerWrap']} data-testid="acp-mcp-picker">
      <ConfigTrigger
        testId="acp-mcp-picker-trigger"
        icon={<Plug size={13} strokeWidth={1.75} aria-hidden="true" />}
        value={
          <>
            {enabledSet.size}/{pool.length}
          </>
        }
        tooltip={localize('acp.mcp.picker.title', 'MCP servers enabled for this session')}
        hasPopup="dialog"
        open={open}
        attrs={{ 'data-custom': custom ? 'true' : 'false' }}
        onRequestOpen={(trigger) => {
          // Pick up a `.mcp.json` edited on disk since the last refresh.
          void service.refreshMcpServerDefinitions()
          onRequestOpen(trigger)
        }}
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
              className: styles['configPopover'],
              role: 'dialog',
              'aria-label': localize(
                'acp.mcp.picker.title',
                'MCP servers enabled for this session',
              ),
              'data-testid': 'acp-mcp-picker-popover',
            } as HTMLAttributes<HTMLDivElement>
          }
        >
          <McpPickerPanel session={session} onRequestClose={onClose} onAltDigit={onAltDigit} />
        </AnchoredSurface>
      ) : null}
    </div>
  )
}

/** Surface-free list content; renders inside any host (picker surface, overflow menu). */
export function McpPickerPanel({
  session,
  onRequestClose,
  onAltDigit,
  onExitUp,
  onExitDown,
}: {
  session: IAcpSession
  /** Invoked before navigating away (e.g. opening settings) so a host surface can dismiss. */
  onRequestClose?: () => void
  onAltDigit?: (digit: number) => void
  onExitUp?: () => void
  onExitDown?: () => void
}) {
  // Soft dependency, same as the picker: stays absent without the ACP layer.
  const service = useOptionalService(IAcpSessionService)
  if (!service) return null
  return (
    <McpPickerPanelInner
      session={session}
      service={service}
      {...(onRequestClose !== undefined ? { onRequestClose } : {})}
      {...(onAltDigit !== undefined ? { onAltDigit } : {})}
      {...(onExitUp !== undefined ? { onExitUp } : {})}
      {...(onExitDown !== undefined ? { onExitDown } : {})}
    />
  )
}

function McpPickerPanelInner({
  session,
  service,
  onRequestClose,
  onAltDigit,
  onExitUp,
  onExitDown,
}: {
  session: IAcpSession
  service: IAcpSessionServiceType
  onRequestClose?: () => void
  onAltDigit?: (digit: number) => void
  onExitUp?: () => void
  onExitDown?: () => void
}) {
  const unionPool = useObservable(service.mcpServerDefinitions)
  const pool = filterPoolForSession(unionPool, session.agentId)
  const sessionAffinity = agentIdToMcpAffinity(session.agentId)
  const selection = useObservable(session.mcpServerSelection)
  const liveServers = useObservable(session.mcpServers)
  const commands = useOptionalService(ICommandService)
  // `null` (inherit) resolves to every non-disabled pool entry — the same
  // default set a brand-new session starts with.
  const { enabledNames } = resolveMcpServerSelection(pool, selection)
  const enabledSet = new Set(enabledNames)
  const custom = selection !== null
  const liveStatus = new Map(liveServers.map((s) => [s.name, s.status]))
  const toggle = (name: string): void => {
    const base = selection ?? enabledNames
    const next = enabledSet.has(name) ? base.filter((n) => n !== name) : [...base, name]
    service.setSessionMcpServers(session.id, next)
  }

  // A checkbox list is the one place Space means "toggle" rather than "confirm":
  // the hook reports it as `preview`, and Enter does the same thing here so both
  // gestures work. Focus stays on the container, so the rows are driven by the
  // cursor rather than by a real checkbox focus ring.
  const listLabel = localize('acp.mcp.picker.title', 'MCP servers enabled for this session')
  const nav = useOverlayListNavigation({
    count: pool.length,
    initialIndex: 0,
    onActivate: (index) => {
      const def = pool[index]
      if (def) toggle(def.name)
    },
    getTypeaheadText: (index) => pool[index]?.name ?? '',
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
    // No listbox on the focus host: this panel is a header, a checkbox list and
    // a footer, and a listbox may only contain options. The role therefore moves
    // down onto the rows' own wrapper, leaving the host an unroled focus holder
    // (same shape as the overflow panel's row list).
    <div ref={nav.containerRef} {...nav.containerProps} role={undefined} aria-label={undefined}>
      <div className={styles['mcpPickHeader']}>
        <span>
          {custom
            ? localize('acp.mcp.picker.custom', 'Custom selection')
            : localize('acp.mcp.picker.inherit', 'Following defaults')}
        </span>
        {custom ? (
          <button
            type="button"
            data-testid="acp-mcp-picker-reset"
            onClick={() => service.setSessionMcpServers(session.id, null)}
          >
            {localize('acp.mcp.picker.reset', 'Reset')}
          </button>
        ) : null}
      </div>
      <div role="listbox" aria-label={listLabel} aria-multiselectable="true">
        {pool.map((def, index) => {
          const rowProps = nav.getItemProps(index)
          return (
            <div
              key={def.name}
              {...rowProps}
              // No mouse activation on the row itself: the session checkbox is
              // the mouse target (a press on a row's empty space must not
              // restart the session, which is what flipping a server does), and
              // every control inside — the checkbox, the two default switches,
              // Reset — owns its own press. Keyboard activation is unaffected:
              // Enter/Space go through the container's key handler.
              onMouseDown={undefined}
              className={styles['mcpPickRow']}
              data-status={liveStatus.get(def.name)}
              data-testid="acp-mcp-picker-row"
              data-name={def.name}
            >
              <label className={styles['mcpPickSession']}>
                <input
                  type="checkbox"
                  checked={enabledSet.has(def.name)}
                  // The container owns the cursor, so the box must not become a
                  // second tab stop the arrow keys cannot reach.
                  tabIndex={-1}
                  onChange={() => toggle(def.name)}
                />
                {liveStatus.has(def.name) ? (
                  <span className={styles['mcpStatusDot']} aria-hidden="true" />
                ) : null}
                <span
                  className={styles['mcpPickName']}
                  data-default-disabled={def.disabled || undefined}
                >
                  {def.name}
                </span>
                <span className={styles['mcpPickMeta']}>
                  {def.agentAffinity !== undefined && (
                    <span
                      className={styles['mcpAffinityBadge']}
                      data-tooltip={
                        def.agentAffinity === 'claude-code'
                          ? localize('acp.mcp.picker.affinityClaude', 'Claude Code sessions only')
                          : localize('acp.mcp.picker.affinityCodex', 'Codex sessions only')
                      }
                    >
                      {def.agentAffinity === 'claude-code' ? 'claude' : 'codex'}
                    </span>
                  )}
                  {def.fromMcpJson
                    ? '.mcp.json'
                    : def.source === 'project'
                      ? localize('acp.mcp.picker.sourceProject', 'project')
                      : def.source === 'extension'
                        ? localize('acp.mcp.picker.sourceExtension', 'extension')
                        : def.source === 'agent-user'
                          ? def.agentAffinity === 'codex'
                            ? localize('acp.mcp.picker.sourceAgentUserCodex', 'codex user')
                            : localize('acp.mcp.picker.sourceAgentUserClaude', 'claude user')
                          : def.source === 'agent-project'
                            ? localize('acp.mcp.picker.sourceAgentProjectCodex', 'codex project')
                            : localize('acp.mcp.picker.sourceGlobal', 'global')}
                </span>
                {sessionAffinity !== undefined &&
                def.sharedWith?.includes(sessionAffinity) === true ? (
                  <span
                    className={styles['mcpSharedHint']}
                    data-tooltip={localize(
                      'acp.mcp.picker.sharedHint',
                      'Also defined for this agent — the entry shown comes from a higher-priority shared layer',
                    )}
                  >
                    {localize('acp.mcp.picker.sharedShort', 'shared')}
                  </span>
                ) : null}
              </label>
              <McpEnablementToggles
                name={def.name}
                showUserToggle={def.hasUserLevelDefinition ?? false}
                compact
              />
            </div>
          )
        })}
      </div>
      <div className={styles['mcpPickFooter']}>
        <button
          type="button"
          data-testid="acp-mcp-picker-open-settings"
          onClick={() => {
            onRequestClose?.()
            void commands?.executeCommand('workbench.action.agent.openMcpSettings')
          }}
        >
          {localize('acp.mcp.picker.openSettings', 'Configure MCP servers…')}
        </button>
      </div>
      <div className={styles['mcpPickHint']}>
        {localize(
          'acp.mcp.picker.cacheHint',
          'Changing servers restarts the session and invalidates the model prompt cache.',
        )}{' '}
        {localize(
          'acp.mcp.picker.defaultHint',
          'Checkboxes on the left apply to this session only; the person/folder switches set the user-level and workspace-level defaults (workspace wins, and can go back to inheriting).',
        )}
      </div>
    </div>
  )
}
