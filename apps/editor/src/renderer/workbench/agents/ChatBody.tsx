/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChatBody — the Copilot-style stack rendered both by SecondarySideBar's
 *  ChatPanel and the full-screen AcpSessionEditor. Session-level config
 *  switches live inside PromptInput's action row to keep the bottom bar
 *  compact.
 *
 *  ChatScroll renders one unified timeline of message / tool_call / plan slots
 *  in arrival order — the canonical view-model is `session.timeline`. Each
 *  streaming agent / thought message shows a blinking caret until the chunk
 *  stream is flushed.
 *
 *  Keyboard navigation: ChatBody registers itself as an AcpChatWidget on
 *  mount. The widget service drives the `acpChatFocused` contextKey from
 *  focusin/focusout on this container, so Alt+J / Alt+K (and Ctrl+Alt+I) only
 *  target whichever ChatBody currently holds DOM focus.
 *--------------------------------------------------------------------------------------------*/

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { Bot, History, Plus } from 'lucide-react'
import { IConfigurationService, localize } from '@universe-editor/platform'
import { useExecuteCommand, useObservable, useService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type TimelineItem,
} from '../../services/acp/acpSessionService.js'
import { hasVisibleMessageContent } from '../../services/acp/acpSession.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import {
  IAcpChatWidgetService,
  type AcpTimelineMoveDirection,
  type AcpTimelineScrollTarget,
} from '../../services/acp/acpChatWidgetService.js'
import { AcpChatViewStateCache } from '../../services/acp/acpChatViewStateCache.js'
import { CollapsibleSlot } from '@universe-editor/workbench-ui'
import { MessageContent } from './MessageContent.js'
import { PermissionCard } from './PermissionCard.js'
import { QuestionCard } from './QuestionCard.js'
import { StickyPlanBar } from './StickyPlanBar.js'
import { StickyUserMessageBar } from './StickyUserMessageBar.js'
import { PromptInput } from './PromptInput.js'
import { ToolCallCard } from './ToolCallCard.js'
import { roleIcon } from './timelineIcons.js'
import { UserMessageItem } from './UserMessageItem.js'
import { StickyScrollOverlay } from './StickyScrollOverlay.js'
import { findByStickyKey, itemSlotKey } from './stickyScroll.js'
import { resolveCollapsed, type CollapseState } from './timelineCollapse.js'
import styles from './agents.module.css'

const STICK_THRESHOLD_PX = 32

export interface WidgetHandle {
  move: (direction: AcpTimelineMoveDirection) => void
  scrollTimeline: (target: AcpTimelineScrollTarget) => void
  focus: () => void
  toggleCollapse: () => void
  cycleCollapseMode: () => void
}

const noop = (): void => {}

const NOOP_HANDLE: WidgetHandle = {
  move: noop,
  scrollTimeline: noop,
  focus: noop,
  toggleCollapse: noop,
  cycleCollapseMode: noop,
}

export function ChatBody({ session, autoFocus }: { session?: IAcpSession; autoFocus?: boolean }) {
  const service = useService(IAcpSessionService)
  const registry = useService(IAcpAgentRegistry)
  const active = useObservable(service.activeSession)
  const target = session ?? active

  if (!target) {
    return <EmptyChat onCreate={() => void service.createSession(registry.defaultAgentId())} />
  }

  return <ChatSessionBody session={target} {...(autoFocus !== undefined ? { autoFocus } : {})} />
}

function ChatSessionBody({ session, autoFocus }: { session: IAcpSession; autoFocus?: boolean }) {
  const widgetService = useService(IAcpChatWidgetService)
  const timeline = useObservable(session.timeline)
  const hasTimelineContent = hasRenderableTimelineContent(timeline)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<WidgetHandle>(NOOP_HANDLE)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const sub = widgetService.register({
      container,
      moveTimeline: (d) => handleRef.current.move(d),
      scrollTimeline: (t) => handleRef.current.scrollTimeline(t),
      focusInput: () => handleRef.current.focus(),
      toggleCollapse: () => handleRef.current.toggleCollapse(),
      cycleCollapseMode: () => handleRef.current.cycleCollapseMode(),
    })
    return () => sub.dispose()
  }, [widgetService, session.id])

  const chatClassName = hasTimelineContent
    ? styles['chat']
    : `${styles['chat']} ${styles['chatEmptySession']}`
  return (
    <div ref={containerRef} className={chatClassName} data-testid="acp-chat">
      <StickyUserMessageBar key={`user:${session.id}`} session={session} />
      <StickyPlanBar key={`plan:${session.id}`} session={session} />
      <ChatScroll key={session.id} session={session} handleRef={handleRef} />
      <PermissionCard session={session} />
      <QuestionCard session={session} />
      <PromptInput
        key={`prompt:${session.id}`}
        session={session}
        handleRef={handleRef}
        {...(autoFocus !== undefined ? { autoFocus } : {})}
      />
    </div>
  )
}

function ChatScroll({
  session,
  handleRef,
}: {
  session: IAcpSession
  handleRef: MutableRefObject<WidgetHandle>
}) {
  const timeline = useObservable(session.timeline)
  const status = useObservable(session.status)
  const isRunning = status === 'running'
  const containerRef = useRef<HTMLDivElement | null>(null)
  const saved = AcpChatViewStateCache.load(session.id)
  const stickRef = useRef(saved?.stuck ?? true)
  // True while we are re-applying a restored scrollTop as content settles, so
  // the programmatic scrolls it triggers don't get mistaken for the user
  // scrolling (which would corrupt `stuck` / overwrite the saved position).
  const restoringRef = useRef(false)
  const [focusedKey, setFocusedKey] = useState<string | null>(saved?.focusedKey ?? null)
  const focusedKeyRef = useRef<string | null>(null)
  focusedKeyRef.current = focusedKey

  const mode = useObservable(session.collapseMode)
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(saved?.collapse?.overrides ?? []),
  )
  const collapse: CollapseState = useMemo(() => ({ mode, overrides }), [mode, overrides])
  const collapseRef = useRef(collapse)
  collapseRef.current = collapse

  // When mode changes from outside (e.g. toggle button), clear per-item overrides.
  const prevModeRef = useRef(mode)
  if (prevModeRef.current !== mode) {
    prevModeRef.current = mode
    setOverrides(new Map())
  }

  // Virtualize only past a threshold so short conversations keep the plain DOM
  // list (cheaper, and what the tests exercise). The scroll element is the same
  // chatBody container in both modes, so bottom-pin / restore that drive
  // `containerRef.scrollTop` need no branching — only keyboard reveal does.
  const configService = useService(IConfigurationService)
  const threshold = configService.get<number>('workbench.chat.virtualizationThreshold')!
  const virtualize = timeline.length > threshold

  const firstUserIdx = timeline.findIndex(
    (it) => it.kind === 'message' && it.message.role === 'user',
  )
  const displayTimeline =
    firstUserIdx >= 0
      ? [...timeline.slice(0, firstUserIdx), ...timeline.slice(firstUserIdx + 1)]
      : timeline

  // Keep the timeline reachable from the keyboard handle without re-binding it on
  // every render (the ref read is cheap; capturing `timeline` would re-allocate
  // the closure each render).
  const timelineRef = useRef(timeline)
  timelineRef.current = timeline
  const displayTimelineRef = useRef(displayTimeline)
  displayTimelineRef.current = displayTimeline

  const hasTimelineContent = hasRenderableTimelineContent(timeline)

  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: virtualize ? displayTimeline.length : 0,
    getScrollElement: () => containerRef.current,
    // Stable, content-derived estimate. It must NOT vary as other rows get
    // measured: a moving estimate shifts every not-yet-measured row's offset on
    // each measurement, so a streaming tail would make the whole list — and any
    // position you've scrolled to — jitter. Same item → same height here; the
    // virtualizer overrides each row with its real measured size once mounted.
    estimateSize: (i) => estimateRow(displayTimeline[i]),
    // Stable per-row identity so measured heights are cached by slot key, not by
    // index — appending / re-slicing the tail during streaming no longer shifts
    // every cached measurement onto the wrong row.
    getItemKey: (i) => {
      const item = displayTimeline[i]
      return item ? slotKey(item) : i
    },
    overscan: 8,
  })
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null)
  virtualizerRef.current = virtualizer

  const persist = useCallback(() => {
    const el = containerRef.current
    // Final flush on unmount: by the time React runs this cleanup it has already
    // torn the scroll container out of the tree — the host ref reads null (and a
    // detached node would report scrollTop 0). Either way reading the live DOM
    // here would clobber the position handleScroll already saved. Only trust the
    // DOM while the container is still connected; otherwise keep the saved value.
    const prev = AcpChatViewStateCache.load(session.id)
    const scrollTop = el?.isConnected ? el.scrollTop : (prev?.scrollTop ?? 0)
    AcpChatViewStateCache.save(session.id, {
      scrollTop,
      stuck: stickRef.current,
      focusedKey: focusedKeyRef.current,
      collapse: {
        mode: collapseRef.current.mode,
        overrides: [...collapseRef.current.overrides],
      },
    })
  }, [session.id])

  // Persist whenever the overrides change (Alt+F / chevron).
  useEffect(() => {
    persist()
  }, [overrides, persist])

  const handleScroll = () => {
    if (restoringRef.current) return
    const el = containerRef.current
    if (!el) return
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop
    stickRef.current = distance <= STICK_THRESHOLD_PX
    persist()
  }

  const handleClick = (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-timeline-key]')
    const key = el?.getAttribute('data-timeline-key')
    if (!key) return
    setFocusedKey(key)
    focusedKeyRef.current = key
    persist()
    // Pull keyboard focus into the scroll container so Alt+J/K — gated on the
    // `acpChatFocused` contextKey, which the widget service drives off focusin —
    // fire without the user first clicking the input. focusin bubbles up to the
    // registered ChatBody container. preventScroll keeps the click position put.
    containerRef.current?.focus({ preventScroll: true })
  }

  // Pin to the very bottom. A single `scrollTop = scrollHeight` lands short in
  // virtual mode: the tail rows are still estimate-sized when we jump, then
  // mount and measure taller on a later frame, growing scrollHeight past where
  // we landed — the cause of "Alt+E needs several presses to reach the end".
  // Re-pin across frames until scrollHeight stops growing. Always assigning
  // scrollTop = scrollHeight (never scrollToIndex) keeps the motion monotonic —
  // it only ever moves toward the bottom, so it never overshoots and flickers.
  const bottomRafRef = useRef<ReturnType<typeof requestAnimationFrame> | undefined>(undefined)
  const scrollToBottomStable = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (bottomRafRef.current !== undefined) cancelAnimationFrame(bottomRafRef.current)
    let tries = 0
    let lastHeight = -1
    const step = (): void => {
      bottomRafRef.current = undefined
      if (!el.isConnected) return
      el.scrollTop = el.scrollHeight
      if (el.scrollHeight !== lastHeight && tries++ < 10) {
        lastHeight = el.scrollHeight
        bottomRafRef.current = requestAnimationFrame(step)
      }
    }
    step()
  }, [])

  // Restore a non-stuck scroll position saved before this session was unmounted
  // (tab switch / session switch). Chat content grows asynchronously — code
  // blocks colorize via Monaco, image data-blocks decode late — so a one-shot
  // assignment lands clamped against a too-short scrollHeight. Re-apply the
  // target as the content settles (ResizeObserver) until a short window elapses
  // or the user takes over. When stuck, fall through to the bottom-pin effect.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !saved || saved.stuck) return
    const target = saved.scrollTop
    restoringRef.current = true

    const apply = (): void => {
      if (!restoringRef.current) return
      if (el.scrollTop !== target) el.scrollTop = target
    }
    apply()

    const ro = new ResizeObserver(apply)
    ro.observe(el)
    const inner = el.firstElementChild
    if (inner) ro.observe(inner)

    const timerRef: { id?: ReturnType<typeof setTimeout> } = {}
    const stop = (): void => {
      if (!restoringRef.current) return
      restoringRef.current = false
      ro.disconnect()
      if (timerRef.id !== undefined) clearTimeout(timerRef.id)
      el.removeEventListener('wheel', stop)
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('keydown', stop)
    }
    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('pointerdown', stop)
    el.addEventListener('keydown', stop)
    timerRef.id = setTimeout(stop, 600)

    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist on unmount as a final flush; session.id is stable for this instance
  // because ChatBody keys ChatScroll by it.
  useEffect(() => {
    return () => {
      if (bottomRafRef.current !== undefined) cancelAnimationFrame(bottomRafRef.current)
      persist()
    }
  }, [persist])

  // Re-pin on slot count AND on the tail's content size so streaming chunks
  // that grow within an existing slot (i.e. text appended to the last agent
  // message) still scroll into view.
  const tailSignature = tailContentSignature(timeline)

  useEffect(() => {
    if (restoringRef.current) return
    if (!stickRef.current) return
    scrollToBottomStable()
  }, [timeline.length, tailSignature, scrollToBottomStable])

  // Stable across renders (reads refs only) so passing it to the memoized
  // TimelineSlot does not bust memo. Toggles the per-item collapse override.
  const handleToggleCollapse = useCallback((key: string) => {
    const item = findByStickyKey(timelineRef.current, key)
    if (!item) return
    const current = resolveCollapsed(key, item, collapseRef.current)
    setOverrides((prev) => {
      const next = new Map(prev)
      next.set(key, !current)
      return next
    })
  }, [])

  // Jump back to a (possibly nested) card's top from its pinned sticky header.
  // Reads the live DOM rect so it works in both render modes; falls back to the
  // virtualizer when the top-level ancestor row is unmounted.
  const handleStickyJump = useCallback((key: string) => {
    const container = containerRef.current
    if (!container) return
    // A user-driven jump: end any in-flight restore and drop bottom-stick so the
    // scroll lands (and stays) where we put it.
    restoringRef.current = false
    stickRef.current = false
    const node = container.querySelector<HTMLElement>(`[data-sticky-key="${cssEscape(key)}"]`)
    if (node) {
      const top = node.getBoundingClientRect().top - container.getBoundingClientRect().top
      container.scrollTop = Math.max(0, container.scrollTop + top)
      return
    }
    const topKey = key.split('/')[0]
    const idx = timelineRef.current.findIndex((it) => slotKey(it) === topKey)
    if (idx >= 0) virtualizerRef.current?.scrollToIndex(idx, { align: 'start' })
  }, [])

  useEffect(() => {
    const handle = handleRef.current
    handle.move = (direction) => {
      const list = displayTimelineRef.current
      if (list.length === 0) return
      const keys = list.map(slotKey)
      const current = focusedKeyRef.current
      let nextIndex: number
      if (direction === 'first') {
        nextIndex = 0
      } else if (direction === 'last') {
        nextIndex = keys.length - 1
      } else if (current === null) {
        nextIndex = direction === 'next' ? 0 : keys.length - 1
      } else {
        const idx = keys.indexOf(current)
        if (idx === -1) {
          nextIndex = direction === 'next' ? 0 : keys.length - 1
        } else if (direction === 'next') {
          nextIndex = Math.min(idx + 1, keys.length - 1)
        } else {
          nextIndex = Math.max(idx - 1, 0)
        }
      }
      const nextKey = keys[nextIndex]
      if (nextKey === undefined) return
      stickRef.current = direction === 'last'
      setFocusedKey(nextKey)
      focusedKeyRef.current = nextKey
      if (direction === 'first') {
        const container = containerRef.current
        if (container) container.scrollTop = 0
        persist()
        return
      }
      if (direction === 'last') {
        scrollToBottomStable()
        persist()
        return
      }
      const container = containerRef.current
      const el = container?.querySelector<HTMLElement>(
        `[data-timeline-key="${cssEscape(nextKey)}"]`,
      )
      // In virtual mode the target row may be unmounted (outside the overscan
      // window), so scrollIntoView finds nothing — fall back to the virtualizer,
      // which scrolls and then mounts it. Mirrors ExplorerView's reveal.
      if (el) {
        el.scrollIntoView({ block: 'nearest' })
      } else {
        virtualizerRef.current?.scrollToIndex(nextIndex, { align: 'center' })
      }
      persist()
    }
    handle.scrollTimeline = (target) => {
      const el = containerRef.current
      if (!el) return
      // Setting scrollTop dispatches onScroll → handleScroll recomputes
      // stickRef and persists, so stick state stays correct without manual work.
      switch (target) {
        case 'up':
          el.scrollTop -= 48
          break
        case 'down':
          el.scrollTop += 48
          break
        case 'top':
          el.scrollTop = 0
          break
        case 'bottom':
          scrollToBottomStable()
          break
        case 'pageUp':
          el.scrollTop -= el.clientHeight
          break
        case 'pageDown':
          el.scrollTop += el.clientHeight
          break
      }
    }
    handle.toggleCollapse = () => {
      const key = focusedKeyRef.current
      if (key !== null) handleToggleCollapse(key)
    }
    handle.cycleCollapseMode = () => {
      session.cycleCollapseMode()
    }
    return () => {
      handle.move = noop
      handle.scrollTimeline = noop
      handle.toggleCollapse = noop
      handle.cycleCollapseMode = noop
    }
  }, [handleRef, handleToggleCollapse, persist, scrollToBottomStable, session])

  return (
    <div
      ref={containerRef}
      className={styles['chatBody']}
      tabIndex={-1}
      onScroll={handleScroll}
      onClick={handleClick}
    >
      <StickyScrollOverlay
        containerRef={containerRef}
        timeline={displayTimeline}
        collapse={collapse}
        onToggleCollapse={handleToggleCollapse}
        onJumpTo={handleStickyJump}
        revision={`${virtualize}:${displayTimeline.length}:${tailSignature}`}
      />
      {!hasTimelineContent ? (
        <EmptySessionHint />
      ) : virtualize ? (
        <div
          className={styles['timelineVirtual']}
          data-testid="acp-timeline"
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const item = displayTimeline[vi.index]
            if (item === undefined) return null
            const key = slotKey(item)
            const slotRunning = isRunning && item.kind === 'message' && item.message.streaming
            return (
              <div
                key={key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                className={styles['timelineRow']}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <TimelineSlot
                  slotKey={key}
                  item={item}
                  sessionRunning={slotRunning}
                  isFocused={key === focusedKey}
                  collapsed={resolveCollapsed(key, item, collapse)}
                  collapse={collapse}
                  onToggleCollapse={handleToggleCollapse}
                />
              </div>
            )
          })}
        </div>
      ) : (
        <ol className={styles['timeline']} data-testid="acp-timeline">
          {displayTimeline.map((item) => {
            const key = slotKey(item)
            // Derive a per-slot running flag: only a streaming message's caret cares
            // about it, so settled slots get a constant `false` and a session
            // start/stop no longer invalidates every memoized slot.
            const slotRunning = isRunning && item.kind === 'message' && item.message.streaming
            return (
              <TimelineSlot
                key={key}
                slotKey={key}
                item={item}
                sessionRunning={slotRunning}
                isFocused={key === focusedKey}
                collapsed={resolveCollapsed(key, item, collapse)}
                collapse={collapse}
                onToggleCollapse={handleToggleCollapse}
              />
            )
          })}
        </ol>
      )}
    </div>
  )
}

function EmptySessionHint() {
  const executeCommand = useExecuteCommand()

  const run = (commandId: string): void => {
    void executeCommand(commandId)
  }

  return (
    <section className={styles['emptySessionHint']} data-testid="acp-empty-session-hint">
      <div className={styles['emptyHintHeader']}>
        <h2 className={styles['emptyHintTitle']}>
          {localize('acp.emptySession.title', 'This session is empty')}
        </h2>
        <p className={styles['emptyHintText']}>
          {localize(
            'acp.emptySession.text',
            'Ask below, or use session actions to switch context.',
          )}
        </p>
      </div>
      <div className={styles['emptyHintSection']}>
        <div className={styles['emptyHintSectionTitle']}>
          {localize('acp.emptySession.start', 'Start')}
        </div>
        <div className={styles['emptyHintActions']}>
          <button
            type="button"
            className={styles['emptyHintButton']}
            onClick={() => run('workbench.action.agent.newSession')}
          >
            <Plus size={14} strokeWidth={1.75} className={styles['emptyHintIcon']} />
            <span>{localize('acp.emptySession.newSession', 'New session')}</span>
          </button>
          <button
            type="button"
            className={styles['emptyHintButton']}
            onClick={() => run('workbench.action.agent.resumeSession')}
          >
            <History size={14} strokeWidth={1.75} className={styles['emptyHintIcon']} />
            <span>{localize('acp.emptySession.resumeSession', 'Resume previous')}</span>
          </button>
          <button
            type="button"
            className={styles['emptyHintButton']}
            onClick={() => run('workbench.action.agent.selectAgent')}
          >
            <Bot size={14} strokeWidth={1.75} className={styles['emptyHintIcon']} />
            <span>{localize('acp.emptySession.chooseAgent', 'Choose agent')}</span>
          </button>
        </div>
      </div>
      <div className={styles['emptyHintSection']}>
        <div className={styles['emptyHintSectionTitle']}>
          {localize('acp.emptySession.keyboard', 'Keyboard')}
        </div>
        <div className={styles['emptyHintGrid']}>
          <HintItem keys={['/']} label={localize('acp.emptySession.commands', 'Commands')} />
          <HintItem keys={['@']} label={localize('acp.emptySession.mentions', 'Mention files')} />
          <HintItem
            keys={['Ctrl+Alt+I']}
            label={localize('acp.emptySession.focusInput', 'Focus input')}
          />
          <HintItem
            keys={['Alt+Up/Down']}
            label={localize('acp.emptySession.nextPrevious', 'Next / previous item')}
          />
          <HintItem
            keys={['Alt+Home/End']}
            label={localize('acp.emptySession.topBottom', 'Top / bottom')}
          />
          <HintItem
            keys={['Ctrl+Alt+F']}
            label={localize('acp.emptySession.collapse', 'Cycle collapse')}
          />
        </div>
      </div>
    </section>
  )
}

function HintItem({ keys, label }: { keys: readonly string[]; label: string }) {
  return (
    <div className={styles['emptyHintItem']}>
      <span className={styles['emptyHintKeys']}>
        {keys.map((key) => (
          <kbd key={key} className={styles['emptyHintKey']}>
            {key}
          </kbd>
        ))}
      </span>
      <span className={styles['emptyHintLabel']}>{label}</span>
    </div>
  )
}

const TimelineSlot = memo(function TimelineSlot({
  slotKey: key,
  item,
  sessionRunning,
  isFocused,
  collapsed,
  collapse,
  onToggleCollapse,
}: {
  slotKey: string
  item: TimelineItem
  sessionRunning: boolean
  isFocused: boolean
  collapsed: boolean
  collapse: CollapseState
  onToggleCollapse: (key: string) => void
}) {
  const focusedClass = isFocused ? ` ${styles['timelineSlotFocused']}` : ''
  switch (item.kind) {
    case 'message': {
      const m = item.message
      // Drop settled messages that render no visible content (e.g. an agent's
      // empty/whitespace thought turn-marker). User messages and the streaming
      // first frame — which shows the caret before its first chunk lands — stay.
      if (!m.streaming && m.role !== 'user' && !hasVisibleMessageContent(m.blocks)) {
        return null
      }
      const showCaret = sessionRunning && m.streaming && !collapsed
      const isUser = m.role === 'user'
      const className = styles['messageItem'] + focusedClass
      return (
        <CollapsibleSlot
          icon={roleIcon(m.role)}
          kindLabel={m.role}
          summary={firstLineSummary(m.text)}
          collapsed={collapsed}
          onToggle={() => onToggleCollapse(key)}
          rootProps={{
            className,
            'data-role': m.role,
            'data-testid': `acp-message-${m.role}`,
            'data-timeline-key': key,
            'data-sticky-key': key,
            'data-sticky-depth': '0',
          }}
        >
          {isUser ? <UserMessageItem blocks={m.blocks} /> : <MessageContent blocks={m.blocks} />}
          {showCaret && (
            <span className={styles['streamingCaret']} aria-hidden="true" data-testid="acp-caret">
              ▍
            </span>
          )}
        </CollapsibleSlot>
      )
    }
    case 'toolCall':
      return (
        <ToolCallCard
          call={item.call}
          dataTimelineKey={key}
          dataStickyKey={key}
          dataStickyDepth={0}
          collapsed={collapsed}
          onToggleCollapse={() => onToggleCollapse(key)}
          subtreeCollapse={{ stickyKey: key, depth: 0, collapse, toggle: onToggleCollapse }}
          {...(isFocused ? { extraClassName: styles['timelineSlotFocused'] ?? '' } : {})}
        />
      )
  }
})

function slotKey(item: TimelineItem): string {
  return itemSlotKey(item)
}

// First non-empty line of a message, trimmed and clamped, for the collapsed
// single-line summary.
function firstLineSummary(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  const MAX = 120
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX)}…` : firstLine
}

// Stable first-paint height estimate, derived only from the row's own content
// length so it never shifts as sibling rows get measured (a moving estimate is
// what made the list jitter). Short rows match the old 64/96 constants; longer
// content estimates taller, which keeps the initial scrollbar from ballooning as
// off-screen rows mount. The virtualizer replaces each value with the real
// measured height once the row is on screen.
function estimateRow(item: TimelineItem | undefined): number {
  if (item === undefined) return 64
  switch (item.kind) {
    case 'message': {
      const lines = Math.max(1, Math.ceil(item.message.text.length / 80))
      return Math.min(44 + lines * 20, 800)
    }
    case 'toolCall': {
      const lines = Math.max(1, Math.ceil(item.call.text.length / 80))
      return Math.min(78 + lines * 18, 600)
    }
  }
}

function tailContentSignature(timeline: readonly TimelineItem[]): number {
  const last = timeline[timeline.length - 1]
  if (!last) return 0
  switch (last.kind) {
    case 'message':
      return last.message.text.length
    case 'toolCall':
      return (
        last.call.text.length +
        last.call.status.length +
        (last.call.children?.reduce(
          (n, c) => n + (c.kind === 'message' ? c.message.text.length : c.call.text.length),
          0,
        ) ?? 0)
      )
  }
}

function hasRenderableTimelineContent(timeline: readonly TimelineItem[]): boolean {
  return timeline.some((item) => {
    if (item.kind === 'toolCall') return true
    const message = item.message
    return message.streaming || message.role === 'user' || hasVisibleMessageContent(message.blocks)
  })
}

// Escape a string for use inside a CSS attribute selector. Timeline keys are
// shaped `m:<uuid>` / `t:<uuid>` / `p:plan` — colons are valid in CSS
// attribute *values* but escaping defensively guards against future id shapes.
function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, '\\$&')
}

function EmptyChat({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={styles['emptyChat']}>
      <p>{localize('acp.empty', 'No active agent session.')}</p>
      <button type="button" className={styles['sendButton']} onClick={onCreate}>
        {localize('acp.newSession', 'New session')}
      </button>
    </div>
  )
}
