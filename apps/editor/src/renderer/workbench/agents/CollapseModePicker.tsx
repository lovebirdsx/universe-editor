/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CollapseModePicker — the timeline display-mode dropdown in the prompt action
 *  row. One icon button plus a small chevron; the popover lists all modes with
 *  their icon, label and a check on the active one (same surface style as the
 *  session config pickers).
 *--------------------------------------------------------------------------------------------*/

import { useRef, useState, type HTMLAttributes } from 'react'
import {
  AlignJustify,
  Brain,
  ChevronDown,
  FoldVertical,
  MessageSquare,
  UnfoldVertical,
  type LucideIcon,
} from 'lucide-react'
import { localize } from '@universe-editor/platform'
import {
  AnchoredSurface,
  useOverlayListNavigation,
  type IOverlayListItemProps,
} from '@universe-editor/workbench-ui'
import type { CollapseMode } from '../../services/acp/session/acpChatViewStateCache.js'
import { COLLAPSE_MODE_ORDER } from '../../services/acp/session/acpCollapseMode.js'
import styles from './agents.module.css'

interface ModeMeta {
  readonly Icon: LucideIcon
  readonly label: string
  readonly description: string
}

const MODE_META: Record<CollapseMode, ModeMeta> = {
  default: {
    Icon: AlignJustify,
    label: localize('acp.collapse.mode.default', 'Smart folding'),
    description: localize(
      'acp.collapse.mode.default.description',
      'Fold messages and tools by type for a readable overview.',
    ),
  },
  collapsed: {
    Icon: FoldVertical,
    label: localize('acp.collapse.mode.collapsed', 'Collapse all'),
    description: localize('acp.collapse.mode.collapsed.description', 'Collapse every card.'),
  },
  expanded: {
    Icon: UnfoldVertical,
    label: localize('acp.collapse.mode.expanded', 'Expand all'),
    description: localize(
      'acp.collapse.mode.expanded.description',
      'Expand every card (at most one sub-agent card stays open).',
    ),
  },
  hideThinking: {
    Icon: Brain,
    label: localize('acp.collapse.mode.hideThinking', 'Hide thinking'),
    description: localize(
      'acp.collapse.mode.hideThinking.description',
      'Hide thinking content, including thinking inside sub-agent cards.',
    ),
  },
  lastMessage: {
    Icon: MessageSquare,
    label: localize('acp.collapse.mode.lastMessage', 'Last message per turn'),
    description: localize(
      'acp.collapse.mode.lastMessage.description',
      'Keep only the final reply of each turn. Tool cards are hidden; sub-agent and key status cards stay.',
    ),
  },
}

export function CollapseModePicker({
  mode,
  onSelect,
  onFocusInput,
}: {
  mode: CollapseMode
  onSelect: (mode: CollapseMode) => void
  onFocusInput: () => void
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<{
    readonly x: number
    readonly y: number
    readonly document: Document
  } | null>(null)
  const open = anchor !== null
  const meta = MODE_META[mode]
  const Icon = meta.Icon
  const tooltip = localize(
    'acp.collapse.menu.tooltip',
    'Timeline display: {mode}. Click to choose.',
    { mode: meta.label },
  )

  const commit = (next: CollapseMode): void => {
    setAnchor(null)
    if (next !== mode) onSelect(next)
    // The popover unmounts on the same press that selected the row; hand focus
    // back to the prompt input once React has committed that unmount.
    queueMicrotask(onFocusInput)
  }

  const close = (): void => setAnchor(null)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles['collapseMenuTrigger']}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tooltip}
        data-tooltip={tooltip}
        data-testid="acp-collapse-mode-trigger"
        onMouseDown={(e) => {
          // The surface's outside-press listener runs on document mousedown; a
          // click on the trigger must toggle instead of closing then reopening.
          e.stopPropagation()
        }}
        onClick={(e) => {
          if (open) {
            close()
            return
          }
          const rect = e.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.left, y: rect.top, document: e.currentTarget.ownerDocument })
        }}
      >
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        <ChevronDown
          size={10}
          strokeWidth={2}
          className={styles['collapseMenuChevron']}
          aria-hidden="true"
        />
      </button>
      {anchor !== null && (
        <AnchoredSurface
          x={anchor.x}
          y={anchor.y}
          placement="top-start"
          offset={4}
          targetDocument={anchor.document}
          onClose={close}
          onEscape={() => {
            setAnchor(null)
            triggerRef.current?.focus({ preventScroll: true })
            return false
          }}
          surfaceProps={
            {
              className: styles['configPopover'],
              'data-testid': 'acp-collapse-mode-popover',
            } as HTMLAttributes<HTMLDivElement>
          }
        >
          <CollapseModeList mode={mode} onCommit={commit} />
        </AnchoredSurface>
      )}
    </>
  )
}

// Mounted only while the popover is open: the navigation hook seeds its cursor
// from `initialIndex` on mount, so reopening lands on the current mode.
function CollapseModeList({
  mode,
  onCommit,
}: {
  mode: CollapseMode
  onCommit: (mode: CollapseMode) => void
}) {
  const nav = useOverlayListNavigation({
    count: COLLAPSE_MODE_ORDER.length,
    initialIndex: COLLAPSE_MODE_ORDER.indexOf(mode),
    onActivate: (index) => {
      const next = COLLAPSE_MODE_ORDER[index]
      if (next !== undefined) onCommit(next)
    },
    getTypeaheadText: (index) => {
      const item = COLLAPSE_MODE_ORDER[index]
      return item === undefined ? '' : MODE_META[item].label
    },
    ariaLabel: localize('acp.collapse.menu.label', 'Timeline display mode'),
  })
  return (
    <div ref={nav.containerRef} {...nav.containerProps}>
      {COLLAPSE_MODE_ORDER.map((item, index) => (
        <ModeRow key={item} mode={item} current={item === mode} nav={nav.getItemProps(index)} />
      ))}
    </div>
  )
}

function ModeRow({
  mode,
  current,
  nav,
}: {
  mode: CollapseMode
  current: boolean
  nav: IOverlayListItemProps
}) {
  const meta = MODE_META[mode]
  const Icon = meta.Icon
  return (
    <div
      {...nav}
      className={styles['configPopoverItem']}
      data-current={current ? 'true' : undefined}
      data-tooltip={meta.description}
    >
      <Icon
        size={14}
        strokeWidth={1.75}
        className={styles['collapseMenuItemIcon']}
        aria-hidden="true"
      />
      <span className={styles['configPopoverItemName']}>{meta.label}</span>
    </div>
  )
}
