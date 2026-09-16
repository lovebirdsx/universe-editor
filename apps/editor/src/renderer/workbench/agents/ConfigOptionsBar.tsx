/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigOptionsBar — compact icon-button row of session-level switches
 *  (model / mode / thought level / custom / sub agent / MCP). Sits inline with
 *  the Send button inside PromptInput's action row. Clicking a trigger opens a
 *  small popover for choosing a value.
 *
 *  The bar is a single line: entry order is the single source of truth in
 *  services/acp/configBarLayout.ts (model… → subagent → mode → thought_level →
 *  custom… → mcp), and when there is not enough width the low-priority tail
 *  moves into the "…" overflow panel (ConfigBarOverflowMenu) instead of
 *  wrapping onto a second line. useConfigBarOverflow measures the line; the
 *  inline popover and the overflow panel are mutually exclusive so
 *  SubagentModelPanel's local state never mounts twice.
 *
 *  Opening is centralized here. The container owns `openId` plus the anchor
 *  point and hands both down, so a trigger no longer computes its own rect —
 *  that is what lets Alt+<n> (ActivateAgentConfigEntryAction), which arrives
 *  with no click event at all, open exactly the way a mouse click does.
 *
 *  The container also owns the Alt+<n> index → entry mapping. The index is the
 *  position in `entries` *including* the overflowed tail, so folding entries
 *  into the "…" panel never renumbers the ones that stay inline.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { Bot, ChevronDown, Settings2, Sliders, Sparkles } from 'lucide-react'
import {
  IDialogService,
  INotificationService,
  Severity,
  constObservable,
  localize,
} from '@universe-editor/platform'
import {
  AnchoredSurface,
  findRowElement,
  useOverlayListNavigation,
  type IOverlayListNavigation,
} from '@universe-editor/workbench-ui'
import { useObservable, useOptionalService, useService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
import type { McpServerDefinition } from '../../services/acp/acpMcpServers.js'
import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'
import {
  findConfigOptionLabel,
  flattenSelectOptions,
} from '../../services/acp/configOptionLabel.js'
import {
  buildConfigBarEntries,
  compareByCategory,
  MCP_ENTRY_KEY,
  SUBAGENT_ENTRY_KEY,
} from '../../services/acp/configBarLayout.js'
import {
  confirmModelSwitchContextShrink,
  evaluateModelSwitchContextShrink,
} from '../../services/acp/session/modelSwitchContextGuard.js'
import { ConfigBarOverflowMenu } from './ConfigBarOverflowMenu.js'
import { isMcpPickerHidden, filterPoolForSession, McpServerPicker } from './McpServerPicker.js'
import { SubagentModelPicker } from './SubagentModelPicker.js'
import { useConfigBarOverflow } from './useConfigBarOverflow.js'
import styles from './agents.module.css'

// Fallback for the soft ACP dependency: without the session service (unit
// tests) there is no pool observable to read, so the hook count stays fixed
// by reading from this constant instead.
const EMPTY_MCP_POOL = constObservable<readonly McpServerDefinition[]>([])

export { findConfigOptionLabel as findLabel }
export { compareByCategory }

/** Viewport point a popover hangs off, in viewport coordinates. */
export interface ConfigBarAnchor {
  readonly x: number
  readonly y: number
}

/** Imperative surface the prompt input drives the Alt+<n> commands through. */
export interface ConfigOptionsBarHandle {
  /**
   * Open the entry at `index` (0-based, in bar order) and put the cursor inside
   * it. An entry that overflowed expands inside the "…" panel instead of its
   * inline popover. Returns false when no entry exists at that index, so the
   * caller can report the miss rather than letting it read as a dead key.
   */
  activateEntry(index: number): boolean
}

/** Entry roots currently in the flex line, in bar order (overflowed ones skip). */
function visibleEntryEls(items: HTMLElement): HTMLElement[] {
  return [...items.querySelectorAll<HTMLElement>('[data-entry-key]')].filter(
    (el) => el.getAttribute('data-overflowed') !== 'true',
  )
}

export function ConfigOptionsBar({
  session,
  handleRef,
}: {
  session: IAcpSession
  handleRef?: Ref<ConfigOptionsBarHandle>
}) {
  const options = useObservable(session.configOptions)
  const service = useOptionalService(IAcpSessionService)
  // Soft, like the session service: unit tests render the bar with a minimal DI
  // container, and the only thing this drives is the out-of-range notice.
  const notifications = useOptionalService(INotificationService)
  const unionPool = useObservable(service?.mcpServerDefinitions ?? EMPTY_MCP_POOL)
  const pool = filterPoolForSession(unionPool, session.agentId)
  const [openId, setOpenId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<ConfigBarAnchor | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [overflowExpandedKey, setOverflowExpandedKey] = useState<string | null>(null)
  const entries = buildConfigBarEntries(options, {
    includeSubagent: session.agentId === 'claude-code',
    includeMcp: !isMcpPickerHidden(session, pool),
  })
  const { itemsRef, overflowRef, entryRefFor, overflowedKeys } = useConfigBarOverflow(entries)

  // The imperative handle and the keydown handler are installed once and must
  // still see the current entry set / open entry, so both live behind refs
  // rather than being rebuilt (and re-installed) on every options update.
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const openIdRef = useRef(openId)
  openIdRef.current = openId

  const entryElFor = useCallback(
    (key: string): HTMLElement | null => {
      const items = itemsRef.current
      return items ? findRowElement(items, 'data-entry-key', key) : null
    },
    [itemsRef],
  )

  // Hand the cursor back to whatever opened the surface. Outside presses skip
  // this — the user already moved on, and pulling focus back would fight them.
  const restoreFocus = useCallback(
    (key: string | null) => {
      if (key === null) return
      entryElFor(key)?.querySelector('button')?.focus()
    },
    [entryElFor],
  )

  const restoreFocusToOpen = useCallback(() => restoreFocus(openIdRef.current), [restoreFocus])

  /**
   * Dismiss the inline popover. `restoreFocus` splits the two families: true
   * for a deliberate close (Escape, a committed pick) that hands the cursor back
   * to the trigger, false for an outside press where the user already moved on.
   */
  const closeInline = useCallback(
    (restoreFocus = false) => {
      if (restoreFocus) restoreFocusToOpen()
      setOpenId(null)
    },
    [restoreFocusToOpen],
  )

  /**
   * Escape is about to peel one level. Return false so AnchoredSurface still
   * dismisses; the focus hand-back happens here because the surface's own
   * onClose also serves outside presses, which must not steal focus.
   */
  const escapeInline = useCallback((): boolean => {
    restoreFocusToOpen()
    return false
  }, [restoreFocusToOpen])

  const openInline = useCallback((key: string, trigger: HTMLElement | null) => {
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    // The inline popover and the overflow panel are mutually exclusive: the
    // sub-agent panel keeps local `changed`/`pendingWrite` state, so its two
    // hosts must never mount it at the same time.
    setOverflowOpen(false)
    setOverflowExpandedKey(null)
    setAnchor({ x: rect.left, y: rect.top })
    setOpenId(key)
  }, [])

  const activateEntry = useCallback(
    (index: number): boolean => {
      const all = entriesRef.current
      const entry = all[index]
      if (!entry) {
        // Report the miss instead of doing nothing: a key that silently no-ops
        // reads as a broken binding. Only here can the count be told — the
        // caller sees a boolean.
        notifications?.notify({
          severity: Severity.Info,
          message: localize('acp.config.entryOutOfRange', 'This session has {0} config entries.', {
            0: all.length,
          }),
        })
        return false
      }
      const el = entryElFor(entry.key)
      // Read the overflow flag off the DOM, not off `overflowedKeys`: the first
      // measurement runs behind a rAF, and until it lands the state is still the
      // empty set while a narrow layout may already have moved this entry out of
      // the flex line — anchoring to it would put the popover where the trigger
      // no longer is.
      if (el?.getAttribute('data-overflowed') === 'true') {
        // The "…" button is the anchor here: this entry's own trigger is inert
        // and out of the flex line, so a popover hung off it would land offscreen.
        const button = overflowRef.current
        if (!button) return false
        const rect = button.getBoundingClientRect()
        setOpenId(null)
        setOverflowExpandedKey(entry.key)
        setAnchor({ x: rect.left, y: rect.top })
        setOverflowOpen(true)
        return true
      }
      openInline(entry.key, el?.querySelector('button') ?? null)
      return true
    },
    [entryElFor, notifications, openInline, overflowRef],
  )

  useImperativeHandle(handleRef, () => ({ activateEntry }), [activateEntry])

  useLayoutEffect(() => {
    if (openId !== null && overflowedKeys.has(openId)) setOpenId(null)
    if (overflowOpen && overflowedKeys.size === 0) setOverflowOpen(false)
  }, [openId, overflowOpen, overflowedKeys])

  // Left/right walk the inline triggers. The popover renders into a portal, so
  // while it is up its own keys never bubble back here — this only ever runs
  // with focus on a trigger.
  const onItemsKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const items = itemsRef.current
      if (!items) return
      const triggers = visibleEntryEls(items)
      const current = triggers.findIndex((el) => el === e.target || el.contains(e.target as Node))
      if (current < 0 || triggers.length === 0) return
      let next: number
      switch (e.key) {
        case 'ArrowRight':
          next = (current + 1) % triggers.length
          break
        case 'ArrowLeft':
          next = (current - 1 + triggers.length) % triggers.length
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = triggers.length - 1
          break
        case 'ArrowDown':
          // Enter / Space already open the trigger through its native click;
          // the down arrow has no native equivalent.
          e.preventDefault()
          triggers[current]?.querySelector('button')?.click()
          return
        default:
          return
      }
      e.preventDefault()
      triggers[next]?.querySelector('button')?.focus()
    },
    [itemsRef],
  )

  const openEntryAt = useCallback(
    (key: string) => (trigger: HTMLElement) => openInline(key, trigger),
    [openInline],
  )
  const switchToEntry = useCallback(
    (digit: number) => {
      activateEntry(digit - 1)
    },
    [activateEntry],
  )

  return (
    <div className={styles['configBar']} data-testid="acp-config-options">
      <div
        className={styles['configBarItems']}
        data-testid="acp-config-options-items"
        ref={itemsRef}
        onKeyDown={onItemsKeyDown}
      >
        {entries.map((entry) => {
          // Overflowed entries stay mounted — hidden via CSS outside the flex
          // line — so their natural offsetWidth keeps feeding the measurement.
          const overflowed = overflowedKeys.has(entry.key)
          return (
            <div
              key={entry.key}
              className={styles['configBarEntry']}
              data-entry-key={entry.key}
              ref={entryRefFor(entry.key)}
              data-overflowed={overflowed ? 'true' : undefined}
              inert={overflowed ? true : undefined}
              aria-hidden={overflowed ? 'true' : undefined}
            >
              {entry.kind === 'option' ? (
                <ConfigOptionTrigger
                  session={session}
                  option={entry.option}
                  open={openId === entry.key}
                  anchor={anchor}
                  onRequestOpen={openEntryAt(entry.key)}
                  onClose={closeInline}
                  onEscape={escapeInline}
                  onAltDigit={switchToEntry}
                />
              ) : entry.kind === 'subagent' ? (
                <SubagentModelPicker
                  session={session}
                  open={openId === SUBAGENT_ENTRY_KEY}
                  anchor={anchor}
                  onRequestOpen={openEntryAt(SUBAGENT_ENTRY_KEY)}
                  onClose={closeInline}
                  onEscape={escapeInline}
                  onAltDigit={switchToEntry}
                />
              ) : (
                <McpServerPicker
                  session={session}
                  open={openId === MCP_ENTRY_KEY}
                  anchor={anchor}
                  onRequestOpen={openEntryAt(MCP_ENTRY_KEY)}
                  onClose={closeInline}
                  onEscape={escapeInline}
                  onAltDigit={switchToEntry}
                />
              )}
            </div>
          )
        })}
        <ConfigBarOverflowMenu
          session={session}
          entries={entries}
          overflowedKeys={overflowedKeys}
          open={overflowOpen}
          anchor={anchor}
          expandedKey={overflowExpandedKey}
          onExpandedKeyChange={setOverflowExpandedKey}
          onOpen={(trigger) => {
            const rect = trigger.getBoundingClientRect()
            setOpenId(null)
            // Reopening starts from the rows: a dismissal (outside press) does
            // not run the collapse path, and a remembered expansion would come
            // back with focus on the "…" button and the arrows pointing at a
            // body that is already open.
            setOverflowExpandedKey(null)
            setAnchor({ x: rect.left, y: rect.top })
            setOverflowOpen(true)
          }}
          onClose={() => setOverflowOpen(false)}
          onAltDigit={switchToEntry}
          buttonRef={overflowRef}
        />
      </div>
    </div>
  )
}

export function categoryIcon(category: SessionConfigOption['category']) {
  switch (category) {
    case 'model':
      return Bot
    case 'mode':
      return Settings2
    case 'thought_level':
      return Sparkles
    default:
      return Sliders
  }
}

/**
 * Shared trigger skeleton: icon + value + chevron. Opening is delegated to the
 * bar so every entry — inline or overflowed — goes through one code path.
 */
export function ConfigTrigger({
  testId,
  icon,
  value,
  tooltip,
  hasPopup,
  open,
  attrs,
  onRequestOpen,
  onClose,
}: {
  testId: string
  icon: ReactNode
  value: ReactNode
  tooltip: string
  hasPopup: 'listbox' | 'dialog'
  open: boolean
  /** Extra button attributes (the data-* flags the CSS keys off). */
  attrs?: Readonly<Record<string, string | undefined>>
  onRequestOpen: (trigger: HTMLElement) => void
  /** Re-click on an already-open trigger: a toggle, not a focus hand-back. */
  onClose: () => void
}) {
  return (
    <button
      type="button"
      className={styles['configTrigger']}
      data-testid={testId}
      aria-haspopup={hasPopup}
      aria-expanded={open}
      data-tooltip={tooltip}
      {...(attrs as HTMLAttributes<HTMLButtonElement>)}
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
        onRequestOpen(e.currentTarget)
      }}
    >
      {icon}
      <span className={styles['configTriggerValue']}>{value}</span>
      <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}

/**
 * Apply a select pick to the session, guarded by the model-switch
 * context-shrink confirmation. Shared with the overflow menu so both entry
 * renderers apply picks identically.
 */
export async function pickConfigValue(
  session: IAcpSession,
  option: SessionConfigOption & { type: 'select' },
  value: string,
  dialogService: IDialogService,
  notificationService: INotificationService,
): Promise<void> {
  if (value === option.currentValue) return
  // Switching a large session onto a smaller-context model silently
  // compacts it on the next prompt — confirm before applying.
  if (option.category === 'model') {
    const shrink = evaluateModelSwitchContextShrink(session.agentId, session.usage.get(), value)
    if (shrink) {
      const label = findConfigOptionLabel(option.options, value)
      const ok = await confirmModelSwitchContextShrink(dialogService, shrink, label)
      if (!ok) return
    }
  }
  // Applying can reject — most visibly when the session was asleep and waking
  // its agent back up failed. Without this the popover would just close and
  // the value silently snap back, so surface the reason.
  try {
    await session.setConfigOption(option.id, value)
  } catch (err) {
    notificationService.notify({
      severity: Severity.Error,
      message: localize('agent.configOption.failed', 'Failed to apply option: {error}', {
        error: (err as Error).message,
      }),
    })
  }
}

function ConfigOptionTrigger({
  session,
  option,
  open,
  anchor,
  onRequestOpen,
  onClose,
  onEscape,
  onAltDigit,
}: {
  session: IAcpSession
  option: SessionConfigOption & { type: 'select' }
  open: boolean
  anchor: ConfigBarAnchor | null
  onRequestOpen: (trigger: HTMLElement) => void
  /** `restoreFocus: true` hands the cursor back to the trigger as it closes. */
  onClose: (restoreFocus?: boolean) => void
  onEscape: () => boolean
  onAltDigit: (digit: number) => void
}) {
  const dialogService = useService(IDialogService)
  const notificationService = useService(INotificationService)
  const Icon = categoryIcon(option.category)
  const currentLabel = findConfigOptionLabel(option.options, option.currentValue)
  const testKey = option.category ?? option.id
  const tooltipParts = [option.name]
  if (option.description) tooltipParts.push(option.description)
  return (
    <div className={styles['configTriggerWrap']} data-testid={`acp-config-${testKey}`}>
      <ConfigTrigger
        testId={`acp-config-${testKey}-trigger`}
        icon={<Icon size={13} strokeWidth={1.75} aria-hidden="true" />}
        value={currentLabel}
        tooltip={tooltipParts.join(' — ')}
        hasPopup="listbox"
        open={open}
        attrs={{ 'data-category': option.category ?? 'custom' }}
        onRequestOpen={onRequestOpen}
        onClose={() => onClose()}
      />
      {open && anchor !== null ? (
        <ConfigOptionPopover
          option={option}
          onCommit={(value) => {
            onClose(true)
            void pickConfigValue(session, option, value, dialogService, notificationService)
          }}
          onDismiss={() => onClose()}
          onEscape={onEscape}
          onAltDigit={onAltDigit}
          testKey={testKey}
          x={anchor.x}
          y={anchor.y}
        />
      ) : null}
    </div>
  )
}

function ConfigOptionPopover({
  option,
  onCommit,
  onDismiss,
  onEscape,
  onAltDigit,
  testKey,
  x,
  y,
}: {
  option: SessionConfigOption & { type: 'select' }
  onCommit: (value: string) => void
  /** Outside press: dismiss, leaving the cursor where the user put it. */
  onDismiss: () => void
  onEscape: () => boolean
  onAltDigit: (digit: number) => void
  testKey: string
  x: number
  y: number
}) {
  return (
    <AnchoredSurface
      x={x}
      y={y}
      placement="top-start"
      offset={4}
      onClose={() => onDismiss()}
      onEscape={onEscape}
      surfaceProps={
        {
          className: styles['configPopover'],
          'data-testid': `acp-config-${testKey}-popover`,
        } as HTMLAttributes<HTMLDivElement>
      }
    >
      <ConfigOptionPanel option={option} onCommit={onCommit} onAltDigit={onAltDigit} />
    </AnchoredSurface>
  )
}

/**
 * Surface-free option list; renders inside any host (the inline popover, an
 * overflow row's expanded body). The host that nests it passes
 * `onExitUp` / `onExitDown` so the cursor falls back out to its rows instead of
 * wrapping here, and `onExitLeft` so ← (and its Ctrl+H alias) collapses that
 * body rather than doing nothing.
 */
export function ConfigOptionPanel({
  option,
  onCommit,
  onAltDigit,
  onExitUp,
  onExitDown,
  onExitLeft,
}: {
  option: SessionConfigOption & { type: 'select' }
  onCommit: (value: string) => void
  onAltDigit?: ((digit: number) => void) | undefined
  onExitUp?: (() => void) | undefined
  onExitDown?: (() => void) | undefined
  /** True = collapsed; false leaves the key to whatever is underneath. */
  onExitLeft?: (() => boolean) | undefined
}) {
  const flat = useMemo(() => flattenSelectOptions(option.options), [option.options])
  // When nested, the ends are exits rather than wrap points.
  const nested = onExitUp !== undefined || onExitDown !== undefined
  const nav = useOverlayListNavigation({
    count: flat.length,
    initialIndex: flat.findIndex((o) => o.value === option.currentValue),
    onActivate: (index) => {
      const picked = flat[index]
      if (picked) onCommit(picked.value)
    },
    getTypeaheadText: (index) => flat[index]?.name ?? '',
    wrap: !nested,
    ariaLabel: option.name,
    ...(onAltDigit !== undefined ? { onAltDigit } : {}),
    ...(onExitUp !== undefined ? { onExitUp } : {}),
    ...(onExitDown !== undefined ? { onExitDown } : {}),
    ...(onExitLeft !== undefined ? { onExitLeft } : {}),
  })
  return (
    // The surface root is the scroll container, so the focus holder is a bare
    // wrapper around it: nothing to style, and the popover's own padding and
    // overflow stay exactly where they were. The wrapper — not the surface — is
    // the listbox: a listbox whose only child is another listbox is invalid, and
    // findRowElement-style lookups go by testid anyway.
    <div ref={nav.containerRef} {...nav.containerProps}>
      {renderPopoverItems(option.options, option.currentValue, nav)}
    </div>
  )
}

/** Render a (possibly grouped) select list as listbox options driven by `nav`. */
export function renderPopoverItems(
  options: readonly SessionConfigSelectOption[] | readonly SessionConfigSelectGroup[],
  current: string,
  nav: IOverlayListNavigation,
): ReactNode {
  if (options.length === 0) return null
  const first = options[0]!
  if (!('group' in first)) {
    const flat = options as readonly SessionConfigSelectOption[]
    return flat.map((v, i) => (
      <PopoverItem key={v.value} option={v} current={current} nav={nav} index={i} />
    ))
  }
  // Group headings stay visible, but the cursor index still runs straight
  // across them: arrow keys must not stop at a group edge.
  let index = 0
  return (options as readonly SessionConfigSelectGroup[]).map((g) => (
    <div key={g.group} className={styles['configPopoverGroup']}>
      <div className={styles['configPopoverGroupLabel']}>{g.name}</div>
      {g.options.map((v) => {
        const row = (
          <PopoverItem key={v.value} option={v} current={current} nav={nav} index={index} />
        )
        index += 1
        return row
      })}
    </div>
  ))
}

function PopoverItem({
  option,
  current,
  nav,
  index,
}: {
  option: SessionConfigSelectOption
  current: string
  nav: IOverlayListNavigation
  index: number
}) {
  return (
    <div
      {...nav.getItemProps(index)}
      className={styles['configPopoverItem']}
      data-current={option.value === current ? 'true' : undefined}
      data-tooltip={option.description ?? option.name}
    >
      <span className={styles['configPopoverItemName']}>{option.name}</span>
    </div>
  )
}
