/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StickyUserMessageBar — pins the latest user message above the chat scroll,
 *  mirroring StickyPlanBar. The message stays in the timeline as part of the
 *  history; this bar is the always-visible copy so the active request never
 *  scrolls out of view. Expanded (the default) it shows the full content;
 *  collapsed it shows the first line. Returns null until a user message exists.
 *
 *  Collapse is driven by ChatScroll's shared override store through the widget
 *  handle (isSlotCollapsed / toggleSlotCollapse / onDidChangeCollapse), so the
 *  chevron, Alt+F on the focused bar, and Ctrl+Alt+F mode cycles all agree and
 *  persist via AcpChatViewStateCache. Without a handle (standalone tests) it
 *  falls back to local state.
 *--------------------------------------------------------------------------------------------*/

import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react'
import { ICommandService, IContextKeyService } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import type { IAcpSession, TimelineItem } from '../../services/acp/session/acpSessionService.js'
import { IAcpChatWidgetService } from '../../services/acp/session/acpChatWidgetService.js'
import { resolveChatContextTarget } from '../../services/acp/chatContextTarget.js'
import { CollapsibleSlot } from '@universe-editor/workbench-ui'
import { MessageContent } from './MessageContent.js'
import { SelectionContextChips, useSelectionContextReveal } from './SelectionContextChips.js'
import { roleIcon } from './timelineIcons.js'
import { AgentChatContextMenu, type AgentChatContextMenuState } from './AgentChatContextMenu.js'
import { SessionCwdPill } from './SessionCwdPill.js'
import { itemSlotKey } from './stickyScroll.js'
import type { WidgetHandle } from './ChatBody.js'
import styles from './agents.module.css'

const SUMMARY_MAX = 80

function clampLine(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX)}…` : firstLine
}

function firstUserItem(
  timeline: readonly TimelineItem[],
): (TimelineItem & { kind: 'message' }) | undefined {
  for (let i = 0; i < timeline.length; i++) {
    const it = timeline[i]
    if (it?.kind === 'message' && it.message.role === 'user')
      return it as TimelineItem & { kind: 'message' }
  }
  return undefined
}

export function StickyUserMessageBar({
  session,
  handleRef,
  onFocusSlot,
}: {
  session: IAcpSession
  handleRef?: MutableRefObject<WidgetHandle>
  onFocusSlot?: (key: string) => void
}) {
  const timeline = useObservable(session.timeline)
  const [menu, setMenu] = useState<AgentChatContextMenuState | null>(null)
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const widgetService = useService(IAcpChatWidgetService)
  const revealSelection = useSelectionContextReveal()

  const item = firstUserItem(timeline)
  const slotKey = item ? itemSlotKey(item) : null

  // Keyboard focus (Alt+A/E/J/K) can land on this bar — it renders the first user
  // message, which is part of the navigation sequence but lives outside the scroll
  // container, so it tracks the focused key through the widget handle. Collapse
  // resolves through the same handle into ChatScroll's shared override store, so
  // Alt+F and Ctrl+Alt+F fold this bar like any in-list slot.
  const [focused, setFocused] = useState(false)
  const [sharedCollapsed, setSharedCollapsed] = useState<boolean | null>(null)
  const [localCollapsed, setLocalCollapsed] = useState(false)
  useEffect(() => {
    const handle = handleRef?.current
    if (!handle || slotKey === null) return
    const syncFocus = (): void => setFocused(handle.getFocusedKey() === slotKey)
    const syncCollapse = (): void => setSharedCollapsed(handle.isSlotCollapsed(slotKey))
    syncFocus()
    syncCollapse()
    const focusSub = handle.onDidChangeFocusedKey(syncFocus)
    const collapseSub = handle.onDidChangeCollapse(syncCollapse)
    return () => {
      focusSub.dispose()
      collapseSub.dispose()
    }
  }, [handleRef, slotKey])
  const collapsed = sharedCollapsed ?? localCollapsed

  if (!item) return null

  const message = item.message

  const toggle = (): void => {
    const handle = handleRef?.current
    if (handle && slotKey !== null) handle.toggleSlotCollapse(slotKey)
    else setLocalCollapsed((v) => !v)
  }

  const handleContextMenu = (e: ReactMouseEvent): void => {
    e.preventDefault()
    if (slotKey !== null) onFocusSlot?.(slotKey)
    widgetService.setHasSelection(!!window.getSelection()?.toString())
    // Mirrors ChatBody's context menu: gates "Ask in Side Chat".
    widgetService.setForkSupported(!session.readOnly && session.forkSupported.get())
    const target = resolveChatContextTarget(e.target as HTMLElement)
    widgetService.setContextTarget(target?.kind)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      args: [{ sessionId: session.id, ...(target ? { target } : {}) }],
    })
  }

  return (
    <ul
      className={styles['stickyUserBar']}
      data-testid="acp-user-bar"
      data-timeline-key={slotKey ?? undefined}
      onContextMenu={handleContextMenu}
    >
      <CollapsibleSlot
        as="li"
        icon={roleIcon('user')}
        kindLabel="user"
        summary={clampLine(message.text)}
        collapsed={collapsed}
        onToggle={toggle}
        headerClassName={styles['stickyUserBarHeader']}
        // The scope badge sits right after the role icon on the header row so
        // it never claims its own vertical line; it renders null for a
        // root/unknown cwd, in which case the header layout is unchanged.
        headerSuffix={<SessionCwdPill session={session} />}
        rootProps={{
          // The focus ring goes on the card (inset by the bar's 12px padding),
          // not the full-width <ul> — a ring at the chat edge gets painted over
          // by the workbench boundary sash. Matches in-list TimelineSlot focus.
          className: `${styles['planCard'] ?? ''}${focused ? ` ${styles['timelineSlotFocused']}` : ''}`,
          'data-testid': 'acp-user-bar-card',
        }}
      >
        <div className={styles['userMessageContent']}>
          <SelectionContextChips
            contexts={message.selectionContexts ?? []}
            onReveal={revealSelection}
          />
          <MessageContent blocks={message.blocks} />
        </div>
      </CollapsibleSlot>
      {menu && (
        <AgentChatContextMenu
          state={menu}
          commandService={commandService}
          contextKeyService={contextKeyService}
          onClose={() => {
            setMenu(null)
            widgetService.setHasSelection(false)
            widgetService.setForkSupported(false)
            widgetService.setContextTarget(undefined)
          }}
        />
      )}
    </ul>
  )
}
