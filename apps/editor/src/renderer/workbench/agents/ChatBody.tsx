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
import { useVirtualizer, type Virtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { Bot, History, Plus } from 'lucide-react'
import { IConfigurationService, ICommandService, localize } from '@universe-editor/platform'
import { useExecuteCommand, useObservable, useService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type TimelineItem,
} from '../../services/acp/acpSessionService.js'
import { hasVisibleMessageContent, timelineItemToText } from '../../services/acp/acpSession.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import {
  IAcpChatWidgetService,
  type AcpChatWidget,
  type AcpTimelineMoveDirection,
  type AcpTimelineScrollTarget,
} from '../../services/acp/acpChatWidgetService.js'
import {
  AcpChatViewStateCache,
  type AcpChatAnchor,
  type AcpChatViewState,
} from '../../services/acp/acpChatViewStateCache.js'
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
import { AgentChatContextMenu, type AgentChatContextMenuState } from './AgentChatContextMenu.js'
import { StickyScrollOverlay } from './StickyScrollOverlay.js'
import { findByStickyKey, itemSlotKey } from './stickyScroll.js'
import { resolveCollapsed, type CollapseState } from './timelineCollapse.js'
import { ChatFindWidget } from './ChatFindWidget.js'
import { useChatFind } from './useChatFind.js'
import styles from './agents.module.css'

const STICK_THRESHOLD_PX = 32

export interface WidgetHandle {
  move: (direction: AcpTimelineMoveDirection) => void
  scrollTimeline: (target: AcpTimelineScrollTarget) => void
  focus: () => void
  jumpToPlan: () => void
  toggleCollapse: () => void
  cycleCollapseMode: () => void
  getFocusedText: () => string | undefined
  popoverSelectNext: () => void
  popoverSelectPrev: () => void
  popoverAccept: () => void
  popoverHide: () => void
  openFind: () => void
  closeFind: () => void
  findNext: () => void
  findPrev: () => void
}

const noop = (): void => {}

const NOOP_HANDLE: WidgetHandle = {
  move: noop,
  scrollTimeline: noop,
  focus: noop,
  jumpToPlan: noop,
  toggleCollapse: noop,
  cycleCollapseMode: noop,
  getFocusedText: () => undefined,
  popoverSelectNext: noop,
  popoverSelectPrev: noop,
  popoverAccept: noop,
  popoverHide: noop,
  openFind: noop,
  closeFind: noop,
  findNext: noop,
  findPrev: noop,
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
  const widgetRef = useRef<AcpChatWidget | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const widget: AcpChatWidget = {
      sessionId: session.id,
      container,
      moveTimeline: (d) => handleRef.current.move(d),
      scrollTimeline: (t) => handleRef.current.scrollTimeline(t),
      focusInput: () => handleRef.current.focus(),
      jumpToPlan: () => handleRef.current.jumpToPlan(),
      toggleCollapse: () => handleRef.current.toggleCollapse(),
      cycleCollapseMode: () => handleRef.current.cycleCollapseMode(),
      getFocusedText: () => handleRef.current.getFocusedText(),
      popoverSelectNext: () => handleRef.current.popoverSelectNext(),
      popoverSelectPrev: () => handleRef.current.popoverSelectPrev(),
      popoverAccept: () => handleRef.current.popoverAccept(),
      popoverHide: () => handleRef.current.popoverHide(),
      openFind: () => handleRef.current.openFind(),
      closeFind: () => handleRef.current.closeFind(),
      findNext: () => handleRef.current.findNext(),
      findPrev: () => handleRef.current.findPrev(),
    }
    widgetRef.current = widget
    const sub = widgetService.register(widget)
    return () => {
      sub.dispose()
      widgetRef.current = null
    }
  }, [widgetService, session.id])

  // PromptInput reports its popover open/closed state up so the widget service
  // can flip `acpPromptPopupVisible` for the focused widget (gates the suggestion
  // navigation commands). Keyed on the widget identity, like focus tracking.
  const handlePopoverOpenChange = useCallback(
    (open: boolean) => {
      const widget = widgetRef.current
      if (widget) widgetService.setPopoverOpen(widget, open)
    },
    [widgetService],
  )

  // Same plumbing for the in-session find widget: ChatScroll reports open/closed
  // up so the service flips `acpChatFindVisible` for the focused widget (gates
  // the F3 / Shift+F3 / Escape find-navigation commands).
  const handleFindVisibleChange = useCallback(
    (open: boolean) => {
      const widget = widgetRef.current
      if (widget) widgetService.setFindVisible(widget, open)
    },
    [widgetService],
  )

  const chatClassName = hasTimelineContent
    ? styles['chat']
    : `${styles['chat']} ${styles['chatEmptySession']}`
  return (
    <div ref={containerRef} className={chatClassName} data-testid="acp-chat">
      <StickyUserMessageBar key={`user:${session.id}`} session={session} />
      <StickyPlanBar key={`plan:${session.id}`} session={session} />
      <ChatScroll
        key={session.id}
        session={session}
        handleRef={handleRef}
        onFindVisibleChange={handleFindVisibleChange}
      />
      <PermissionCard session={session} />
      <QuestionCard key={`question:${session.id}`} session={session} />
      <PromptInput
        key={`prompt:${session.id}`}
        session={session}
        handleRef={handleRef}
        onPopoverOpenChange={handlePopoverOpenChange}
        {...(autoFocus !== undefined ? { autoFocus } : {})}
      />
    </div>
  )
}

function ChatScroll({
  session,
  handleRef,
  onFindVisibleChange,
}: {
  session: IAcpSession
  handleRef: MutableRefObject<WidgetHandle>
  onFindVisibleChange: (open: boolean) => void
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
  // True while the stuck-restore window is re-pinning the view to the bottom each
  // frame. Unlike restoringRef this does NOT gate handleScroll: a real outside
  // scroll during the window must still flip `stuck` to false so the pin aborts.
  const pinningRef = useRef(false)
  const [focusedKey, setFocusedKey] = useState<string | null>(saved?.focusedKey ?? null)
  const focusedKeyRef = useRef<string | null>(null)
  focusedKeyRef.current = focusedKey
  const [menu, setMenu] = useState<AgentChatContextMenuState | null>(null)
  const commandService = useService(ICommandService)

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

  // In-session find. While the find bar is open we force the plain <ol> (below)
  // so the whole session is in the DOM — the TreeWalker, scrollIntoView reveal
  // and highlight ranges then cover messages that virtualization would unmount.
  const find = useChatFind(
    containerRef,
    `${timeline.length}:${tailContentSignature(timeline)}`,
    onFindVisibleChange,
  )
  const virtualize = timeline.length > threshold && !find.visible
  // Let persist()/the restore effect read the live mode without re-binding to it.
  const virtualizeRef = useRef(virtualize)
  virtualizeRef.current = virtualize

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

  // Feed the previously measured row heights back into a freshly mounted
  // virtualizer (A). Without this the remounted instance falls back to
  // estimateRow for every row, so its total size — and therefore the scrollbar
  // and the meaning of any restored scrollTop — disagrees with what the user
  // last saw. Sizes are keyed by slotKey, so they re-attach to the right rows
  // even if streaming appended new items while this session was unmounted; the
  // start/end/index/lane fields are placeholders the virtualizer recomputes
  // immediately (it only reads key + size from this seed).
  const initialMeasurementsCache = useMemo<VirtualItem[]>(
    () =>
      (saved?.measurements ?? []).map((m) => ({
        index: 0,
        start: 0,
        size: m.size,
        end: m.size,
        key: m.key,
        lane: 0,
      })),
    // saved is read once at mount; recomputing on later renders would be wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Track which rows have actually been mounted+measured (vs. still carrying an
  // estimateRow guess). `virtualizer.measurementsCache` mixes both — every row
  // up to `count` is in it, but off-screen rows hold the coarse estimate. Saving
  // that blend would persist estimates as if they were truth, so the next mount
  // locks them into itemSizeCache and the coordinate system drifts a little each
  // time (the "switch back twice → snaps to the top" bug). Seed from the saved
  // keys: those were real measurements last time.
  const measuredKeysRef = useRef<Set<string>>(
    new Set((saved?.measurements ?? []).map((m) => m.key)),
  )

  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: virtualize ? displayTimeline.length : 0,
    getScrollElement: () => containerRef.current,
    initialMeasurementsCache,
    initialOffset: saved && !saved.stuck ? saved.scrollTop : 0,
    // Stable, content-derived estimate. It must NOT vary as other rows get
    // measured: a moving estimate shifts every not-yet-measured row's offset on
    // each measurement, so a streaming tail would make the whole list — and any
    // position you've scrolled to — jitter. Same item → same height here; the
    // virtualizer overrides each row with its real measured size once mounted.
    estimateSize: (i) => {
      const item = displayTimeline[i]
      return estimateRow(item, item ? resolveCollapsed(slotKey(item), item, collapse) : false)
    },
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

  // measureElement, but also remember the row's slotKey as genuinely measured so
  // persist() can tell real heights from estimates. The virtualizer reads the
  // index off data-index; we read data-slot-key (set on the same node) to record
  // the key, then delegate.
  const measureElement = useCallback((node: Element | null) => {
    if (node) {
      const key = node.getAttribute('data-slot-key')
      if (key) measuredKeysRef.current.add(key)
    }
    virtualizerRef.current?.measureElement(node)
  }, [])

  const persist = useCallback(() => {
    const el = containerRef.current
    // Final flush on unmount: by the time React runs this cleanup it has already
    // torn the scroll container out of the tree — the host ref reads null (and a
    // detached node would report scrollTop 0). Either way reading the live DOM
    // here would clobber the position handleScroll already saved. Only trust the
    // DOM while the container is still connected; otherwise keep the saved value.
    const prev = AcpChatViewStateCache.load(session.id)
    // While a restore is still converging (its RAF window hasn't ended), the live
    // scrollTop/anchor are mid-flight — not where the user left the view. A quick
    // switch-back-and-away unmounts during this window; capturing now would write
    // the half-restored position back over the correct saved one, and the next
    // restore lands on it → the view creeps to the top across repeated switches.
    // Keep the saved position untouched in that case (collapse/focus still update).
    const restoring = restoringRef.current
    const connected = el?.isConnected ?? false
    const canReadDom = connected && !restoring
    const scrollTop = canReadDom && el ? el.scrollTop : (prev?.scrollTop ?? 0)
    // Anchor (B): the slot at the top of the viewport + the offset into it. On
    // restore we re-resolve the slot's offset in the *current* coordinate system,
    // so a position survives the estimate→measured height shift that a raw
    // scrollTop cannot. Only computable while connected and virtualizing; keep
    // the previous anchor otherwise so an unmount flush never wipes it.
    const vz = virtualizerRef.current
    const anchor =
      canReadDom && el && virtualizeRef.current && vz ? captureAnchor(el) : prev?.anchor
    const stuck = canReadDom ? stickRef.current : (prev?.stuck ?? stickRef.current)
    // Measurements (A): the real per-row heights, captured before unmount and
    // replayed via initialMeasurementsCache. Persist ONLY rows that were actually
    // mounted+measured (measuredKeysRef) — measurementsCache also holds estimate
    // values for off-screen rows, and persisting those would poison the next
    // mount's itemSizeCache. Keep the previous snapshot if nothing real measured
    // yet (e.g. plain-list mode).
    const measured =
      vz && vz.measurementsCache && vz.measurementsCache.length > 0
        ? vz.measurementsCache
            .filter((m) => measuredKeysRef.current.has(String(m.key)))
            .map((m) => ({ key: String(m.key), size: m.size }))
        : []
    const measurements = measured.length > 0 ? measured : prev?.measurements
    const next: AcpChatViewState = {
      scrollTop,
      stuck,
      focusedKey: focusedKeyRef.current,
      collapse: {
        mode: collapseRef.current.mode,
        overrides: [...collapseRef.current.overrides],
      },
    }
    if (anchor) next.anchor = anchor
    if (measurements) next.measurements = measurements
    AcpChatViewStateCache.save(session.id, next)
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
    focusSlot(key)
  }

  // Set the focused slot and pull keyboard focus into the scroll container so
  // Alt+J/K — gated on the `acpChatFocused` contextKey, which the widget service
  // drives off focusin — fire without the user first clicking the input. focusin
  // bubbles up to the registered ChatBody container. preventScroll keeps the
  // click position put.
  const focusSlot = (key: string): void => {
    setFocusedKey(key)
    focusedKeyRef.current = key
    persist()
    containerRef.current?.focus({ preventScroll: true })
  }

  const handleContextMenu = (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-timeline-key]')
    const key = el?.getAttribute('data-timeline-key')
    if (key) focusSlot(key)
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
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
  // (tab switch / session switch). Two things make a raw scrollTop unreliable in
  // virtual mode: content grows asynchronously (Monaco colorizes, images decode),
  // and — the dominant effect — the rows ABOVE the anchor are mostly unmeasured
  // after a remount, so the virtualizer places them with estimateRow. Those
  // estimates run systematically short, so getOffsetForIndex(anchor) returns a
  // too-small start and the position creeps toward the top, collapsing to 0 after
  // a couple of round trips.
  //
  // The fix anchors against the real DOM rect, which is independent of the
  // estimate coordinate system: bring the anchored row into the DOM via the
  // (approximate) estimated offset, then read its actual position and align it so
  // its top sits `offset` px above the viewport top. A RAF loop re-aligns every
  // frame for a short window — as rows above measure (estimate → real) the row
  // drifts down and the next frame pulls it back, converging on the exact spot.
  // Plain-list mode (below the threshold) has no virtualizer to anchor against and
  // uses the raw scrollTop, reliable there since the full <ol> never re-estimates.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    // Stuck (pinned to bottom) on remount: the bottom-pin effect is keyed on
    // timeline length / tail signature, which are unchanged across a tab switch,
    // so it does not re-fire. With `.timelineVirtual { flex: none }` the spacer
    // honours its full getTotalSize() height, so the initialOffset of 0 leaves the
    // view at the top instead of (previously) a collapsed-short container that
    // happened to sit near the end. A single re-pin is not enough either: in
    // virtual mode rows mount/unmount as we jump, re-measure, and shift the total
    // by up to ~1000px for several frames, and the virtualizer's own size-change
    // adjustment can pull the offset back up. Pin to the bottom every frame for a
    // short window so the view rides the total to its settled value, aborting on
    // the first real user scroll input.
    if (!saved || saved.stuck) {
      pinningRef.current = true
      stickRef.current = true
      const vz0 = virtualizerRef.current
      if (vz0) vz0.shouldAdjustScrollPositionOnItemSizeChange = () => false
      let rafId: number | undefined
      let lastPinnedTop = -1
      const startedAt = performance.now()
      const stop = (): void => {
        if (!pinningRef.current) return
        pinningRef.current = false
        const vz = virtualizerRef.current
        if (vz) vz.shouldAdjustScrollPositionOnItemSizeChange = undefined
        if (rafId !== undefined) cancelAnimationFrame(rafId)
        el.removeEventListener('wheel', stop)
        el.removeEventListener('pointerdown', stop)
        el.removeEventListener('keydown', stop)
      }
      const tick = (): void => {
        rafId = undefined
        if (!pinningRef.current) return
        // Distinguish the two reasons scrollTop sits below the bottom:
        //  - content grew (rows mounted/measured): the browser keeps scrollTop where
        //    we pinned it last frame while scrollHeight rose → keep pinning.
        //  - an outside scroll (user wheel / programmatic set) pulled scrollTop UP
        //    from where we pinned it → stop and let the new position stand.
        if (lastPinnedTop >= 0 && el.scrollTop < lastPinnedTop - 4) {
          stop()
          return
        }
        el.scrollTop = el.scrollHeight
        lastPinnedTop = el.scrollTop
        if (performance.now() - startedAt < 600) rafId = requestAnimationFrame(tick)
        else stop()
      }
      el.scrollTop = el.scrollHeight
      lastPinnedTop = el.scrollTop
      rafId = requestAnimationFrame(tick)
      el.addEventListener('wheel', stop, { passive: true })
      el.addEventListener('pointerdown', stop)
      el.addEventListener('keydown', stop)
      return stop
    }
    restoringRef.current = true

    // While restoring we drive scrollTop by hand each frame. The virtualizer's
    // default correction independently nudges scrollOffset when an above-viewport
    // row measures taller/shorter; the two fight and the position creeps. Suppress
    // it for the restore window, then restore the native default on stop.
    const vz0 = virtualizerRef.current
    if (vz0) vz0.shouldAdjustScrollPositionOnItemSizeChange = () => false

    const anchor = saved.anchor

    const applyOnce = (): void => {
      const vz = virtualizerRef.current
      if (anchor && virtualizeRef.current && vz) {
        // Authoritative path: the anchored row is in the DOM — align by its real
        // rect, immune to estimated heights above it.
        const node = el.querySelector<HTMLElement>(`[data-slot-key="${cssEscape(anchor.key)}"]`)
        if (node) {
          const relTop = node.getBoundingClientRect().top - el.getBoundingClientRect().top
          const max = Math.max(0, el.scrollHeight - el.clientHeight)
          const next = Math.max(0, Math.min(el.scrollTop + relTop + anchor.offset, max))
          if (Math.abs(el.scrollTop - next) > 0.5) el.scrollTop = next
          return
        }
        // Not mounted yet: ask the virtualizer to scroll the row's index into view
        // (recomputes its range and mounts the row), so a later frame can take the
        // DOM path above. scrollToIndex is reliable here where a hand-set scrollTop
        // against the estimate coordinate system is not.
        const index = displayTimelineRef.current.findIndex((it) => slotKey(it) === anchor.key)
        if (index >= 0) {
          vz.scrollToIndex(index, { align: 'start' })
          return
        }
      }
      if (el.scrollTop !== saved.scrollTop) el.scrollTop = saved.scrollTop
    }

    applyOnce()

    let rafId: number | undefined
    const startedAt = performance.now()
    const stop = (): void => {
      if (!restoringRef.current) return
      restoringRef.current = false
      const vz = virtualizerRef.current
      if (vz) vz.shouldAdjustScrollPositionOnItemSizeChange = undefined
      if (rafId !== undefined) cancelAnimationFrame(rafId)
      el.removeEventListener('wheel', stop)
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('keydown', stop)
    }
    const tick = (): void => {
      rafId = undefined
      if (!restoringRef.current) return
      applyOnce()
      if (performance.now() - startedAt < 600) rafId = requestAnimationFrame(tick)
      else stop()
    }
    rafId = requestAnimationFrame(tick)

    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('pointerdown', stop)
    el.addEventListener('keydown', stop)

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
    handle.getFocusedText = () => {
      const key = focusedKeyRef.current
      if (!key) return undefined
      const item = timelineRef.current.find((it) => slotKey(it) === key)
      return item ? timelineItemToText(item) : undefined
    }
    handle.jumpToPlan = () => {
      const list = displayTimelineRef.current
      // The agent's plan reaches the timeline as an ExitPlanMode tool call
      // (kind 'switch_mode'). Jump to the most recent one — re-entering plan
      // mode appends a fresh card, and the latest is what the user means.
      let targetIndex = -1
      for (let i = list.length - 1; i >= 0; i--) {
        const it = list[i]
        if (it && it.kind === 'toolCall' && it.call.kind === 'switch_mode') {
          targetIndex = i
          break
        }
      }
      if (targetIndex < 0) return
      const item = list[targetIndex]
      if (!item) return
      const nextKey = slotKey(item)
      stickRef.current = false
      setFocusedKey(nextKey)
      focusedKeyRef.current = nextKey
      const container = containerRef.current
      const el = container?.querySelector<HTMLElement>(
        `[data-timeline-key="${cssEscape(nextKey)}"]`,
      )
      if (el) {
        el.scrollIntoView({ block: 'nearest' })
      } else {
        virtualizerRef.current?.scrollToIndex(targetIndex, { align: 'center' })
      }
      persist()
    }
    return () => {
      handle.move = noop
      handle.scrollTimeline = noop
      handle.jumpToPlan = noop
      handle.toggleCollapse = noop
      handle.cycleCollapseMode = noop
      handle.getFocusedText = () => undefined
    }
  }, [handleRef, handleToggleCollapse, persist, scrollToBottomStable, session])

  // Find commands bind separately: the callbacks come from useChatFind and are
  // stable, so this effect only re-runs if one identity actually changes — it
  // doesn't share the timeline-navigation effect's dependency churn.
  const { open: openFind, close: closeFind, next: nextFind, prev: prevFind } = find
  useEffect(() => {
    const handle = handleRef.current
    handle.openFind = openFind
    handle.findNext = nextFind
    handle.findPrev = prevFind
    // Closing returns keyboard focus to the scroll container so subsequent
    // Alt+J/K keep working without a click (the input had stolen focus).
    handle.closeFind = () => {
      closeFind()
      containerRef.current?.focus({ preventScroll: true })
    }
    return () => {
      handle.openFind = noop
      handle.closeFind = noop
      handle.findNext = noop
      handle.findPrev = noop
    }
  }, [handleRef, openFind, closeFind, nextFind, prevFind])

  return (
    <div
      ref={containerRef}
      className={styles['chatBody']}
      tabIndex={-1}
      onScroll={handleScroll}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {find.visible && (
        <ChatFindWidget
          query={find.query}
          count={find.count}
          currentIndex={find.currentIndex}
          onQueryChange={find.setQuery}
          onNext={find.next}
          onPrev={find.prev}
          onClose={() => handleRef.current.closeFind()}
        />
      )}
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
                ref={measureElement}
                data-index={vi.index}
                data-slot-key={key}
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
      {menu && (
        <AgentChatContextMenu
          state={menu}
          commandService={commandService}
          onClose={() => setMenu(null)}
        />
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

// Capture the slot at the top of the viewport plus how far into it we've
// scrolled. Captured from the live DOM — NOT the virtualizer's coordinate
// system — so it stays consistent with the restore path, which also aligns by
// getBoundingClientRect. getVirtualItemForOffset would pick the row spanning
// scrollTop in the estimate coordinate space; when the rows above hold estimate
// heights that differ from reality, that row is not the one actually at the top
// of the viewport, and the captured offset drifts a little every remount until
// the position collapses to the top. Walking the mounted rows top-to-bottom and
// taking the first one still (partially) visible avoids that entirely. `offset`
// is how far the row's top sits above the container's top edge (>= 0), the exact
// quantity the restore effect adds back.
function captureAnchor(el: HTMLElement): AcpChatAnchor | undefined {
  const containerTop = el.getBoundingClientRect().top
  const rows = el.querySelectorAll<HTMLElement>('[data-slot-key]')
  for (const row of rows) {
    const key = row.getAttribute('data-slot-key')
    if (!key) continue
    const rect = row.getBoundingClientRect()
    const top = rect.top - containerTop
    const bottom = rect.bottom - containerTop
    if (bottom <= 0) continue // entirely scrolled above the viewport
    return { key, offset: Math.max(0, -top) }
  }
  return undefined
}

// First non-empty line of a message, trimmed and clamped, for the collapsed
// single-line summary.
function firstLineSummary(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  const MAX = 120
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX)}…` : firstLine
}

// Stable first-paint height estimate, derived from the row's content AND how it
// renders. It must not shift as sibling rows get measured (a moving estimate
// jitters the list), but until a row is measured this value drives
// getTotalSize() — i.e. the scrollbar thumb. The dominant error source is row
// kinds with a CAPPED height: a `default`/`thought`-collapsed card is compact
// regardless of body length, and a USER message body is clamped to a fixed
// max-height (160px, internal scroll) so a long prompt never grows the row.
// Estimating those as if they expanded with content made the scrollbar balloon
// as they scrolled in and measured far shorter — the "scrollbar longer up top,
// shrinks scrolling down" bug. Constants are fitted to measured real heights:
// collapsed ≈ 190px, user-clamped ≈ 224px, free-growing ≈ base + lines × 21.
const ESTIMATE_WRAP_COLS = 90
const ESTIMATE_COLLAPSED = 190
const ESTIMATE_USER_MAX = 224

function estimateLineCount(text: string): number {
  let lines = 0
  for (const seg of text.split('\n')) {
    lines += Math.max(1, Math.ceil(seg.length / ESTIMATE_WRAP_COLS))
  }
  return Math.max(1, lines)
}

function estimateRow(item: TimelineItem | undefined, collapsed: boolean): number {
  if (item === undefined) return 64
  if (collapsed) return ESTIMATE_COLLAPSED
  switch (item.kind) {
    case 'message': {
      const lines = estimateLineCount(item.message.text)
      const free = 60 + lines * 21
      // User prompts are clamped to a fixed max-height and scroll internally, so
      // their row height saturates instead of growing with the body.
      if (item.message.role === 'user') return Math.min(free, ESTIMATE_USER_MAX)
      return Math.min(free, 4000)
    }
    case 'toolCall': {
      const lines = estimateLineCount(item.call.text)
      return Math.min(78 + lines * 20, 3000)
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
