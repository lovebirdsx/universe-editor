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
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react'
import { measureElement, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { IConfigurationService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
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
import {
  AcpChatViewStateCache,
  type CollapseMode,
} from '../../services/acp/acpChatViewStateCache.js'
import { CollapsibleSlot } from './CollapsibleSlot.js'
import { MessageContent } from './MessageContent.js'
import { PermissionCard } from './PermissionCard.js'
import { QuestionCard } from './QuestionCard.js'
import { StickyPlanBar } from './StickyPlanBar.js'
import { StickyUserMessageBar } from './StickyUserMessageBar.js'
import { PromptInput } from './PromptInput.js'
import { ToolCallCard } from './ToolCallCard.js'
import { roleIcon } from './timelineIcons.js'
import { UserMessageItem } from './UserMessageItem.js'
import styles from './agents.module.css'

const STICK_THRESHOLD_PX = 32

export interface WidgetHandle {
  move: (direction: AcpTimelineMoveDirection) => void
  scrollTimeline: (target: AcpTimelineScrollTarget) => void
  focus: () => void
  toggleCollapse: () => void
  cycleCollapseMode: () => void
}

interface CollapseState {
  mode: CollapseMode
  overrides: ReadonlyMap<string, boolean>
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
  const widgetService = useService(IAcpChatWidgetService)
  const active = useObservable(service.activeSession)
  const target = session ?? active
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
  }, [widgetService, target?.id])

  if (!target) {
    return <EmptyChat onCreate={() => void service.createSession(registry.defaultAgentId())} />
  }

  return (
    <div ref={containerRef} className={styles['chat']} data-testid="acp-chat">
      <StickyUserMessageBar key={`user:${target.id}`} session={target} />
      <StickyPlanBar key={`plan:${target.id}`} session={target} />
      <ChatScroll key={target.id} session={target} handleRef={handleRef} />
      <PermissionCard session={target} />
      <QuestionCard session={target} />
      <PromptInput
        key={`prompt:${target.id}`}
        session={target}
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

  const [collapse, setCollapse] = useState<CollapseState>(() => ({
    mode: saved?.collapse?.mode ?? 'default',
    overrides: new Map(saved?.collapse?.overrides ?? []),
  }))
  const collapseRef = useRef(collapse)
  collapseRef.current = collapse

  // Virtualize only past a threshold so short conversations keep the plain DOM
  // list (cheaper, and what the tests exercise). The scroll element is the same
  // chatBody container in both modes, so bottom-pin / restore that drive
  // `containerRef.scrollTop` need no branching — only keyboard reveal does.
  const configService = useService(IConfigurationService)
  const threshold = configService.get<number>('workbench.chat.virtualizationThreshold') ?? 100
  const virtualize = timeline.length > threshold
  const virtualizeRef = useRef(virtualize)
  virtualizeRef.current = virtualize

  // Keep the timeline reachable from virtualizer callbacks (measureElement runs
  // async off a ResizeObserver, so its captured closure can lag a frame) and
  // from the keyboard handle without re-binding it on every render.
  const timelineRef = useRef(timeline)
  timelineRef.current = timeline

  // Adaptive per-kind row-height estimate. Chat rows are far taller and far more
  // variable than a fixed 64/96px guess, so the virtualizer's total size used to
  // balloon as off-screen rows mounted and measured for real — the scrollbar
  // "growing" on the way down. Feeding back the running mean of measured rows
  // keeps the estimate for not-yet-measured rows close to reality, so the total
  // size (and the scrollbar) stays stable.
  const avgRef = useRef({ message: 64, toolCall: 96 })

  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: virtualize ? timeline.length : 0,
    getScrollElement: () => containerRef.current,
    estimateSize: (i) => {
      const item = timeline[i]
      if (item === undefined) return 64
      return item.kind === 'message' ? avgRef.current.message : avgRef.current.toolCall
    },
    // Stable per-row identity so measured heights are cached by slot key, not by
    // index — appending / re-slicing the tail during streaming no longer shifts
    // every cached measurement onto the wrong row.
    getItemKey: (i) => {
      const item = timeline[i]
      return item ? slotKey(item) : i
    },
    measureElement: (el, entry, instance) => {
      const size = measureElement(el, entry, instance)
      const item = timelineRef.current[instance.indexFromElement(el)]
      if (item) {
        const k = item.kind === 'message' ? 'message' : 'toolCall'
        avgRef.current[k] = avgRef.current[k] * 0.8 + size * 0.2
      }
      return size
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

  // Persist whenever the collapse state changes (Alt+F / Ctrl+Alt+F / chevron).
  useEffect(() => {
    persist()
  }, [collapse, persist])

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

  // Pin to the very bottom. A single `scrollTop = scrollHeight` (or one
  // scrollToIndex) lands short in virtual mode: the tail rows are still
  // estimate-sized when we jump, then mount and measure taller, so the real
  // bottom moves further down than where we landed — the cause of "Alt+E needs
  // several presses to reach the end". Re-issue the jump across a few frames
  // until the remaining distance settles within the stick threshold.
  const bottomRafRef = useRef<ReturnType<typeof requestAnimationFrame> | undefined>(undefined)
  const scrollToBottomStable = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (bottomRafRef.current !== undefined) cancelAnimationFrame(bottomRafRef.current)
    let tries = 0
    const step = (): void => {
      bottomRafRef.current = undefined
      if (!el.isConnected) return
      const v = virtualizerRef.current
      const list = timelineRef.current
      if (virtualizeRef.current && v && list.length > 0) {
        v.scrollToIndex(list.length - 1, { align: 'end' })
      } else {
        el.scrollTop = el.scrollHeight
      }
      const distance = el.scrollHeight - el.clientHeight - el.scrollTop
      if (distance > STICK_THRESHOLD_PX && tries++ < 10) {
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
    const item = timelineRef.current.find((it) => slotKey(it) === key)
    if (!item) return
    const current = resolveCollapsed(key, item, collapseRef.current)
    setCollapse((s) => {
      const overrides = new Map(s.overrides)
      overrides.set(key, !current)
      return { mode: s.mode, overrides }
    })
  }, [])

  useEffect(() => {
    const handle = handleRef.current
    handle.move = (direction) => {
      const list = timelineRef.current
      if (list.length === 0) return
      const keys = list.map(slotKey)
      const current = focusedKeyRef.current
      let nextIndex: number
      if (current === null) {
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
      stickRef.current = false
      setFocusedKey(nextKey)
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
    }
    handle.scrollTimeline = (target) => {
      const el = containerRef.current
      if (!el) return
      // Setting scrollTop dispatches onScroll → handleScroll recomputes
      // stickRef and persists, so stick state stays correct without manual work.
      switch (target) {
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
      setCollapse((s) => ({ mode: nextCollapseMode(s.mode), overrides: new Map() }))
    }
    return () => {
      handle.move = noop
      handle.scrollTimeline = noop
      handle.toggleCollapse = noop
      handle.cycleCollapseMode = noop
    }
  }, [handleRef, handleToggleCollapse, scrollToBottomStable])

  return (
    <div
      ref={containerRef}
      className={styles['chatBody']}
      tabIndex={-1}
      onScroll={handleScroll}
      onClick={handleClick}
    >
      {virtualize ? (
        <div
          className={styles['timelineVirtual']}
          data-testid="acp-timeline"
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const item = timeline[vi.index]
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
                  onToggleCollapse={handleToggleCollapse}
                />
              </div>
            )
          })}
        </div>
      ) : (
        <ol className={styles['timeline']} data-testid="acp-timeline">
          {timeline.map((item) => {
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
                onToggleCollapse={handleToggleCollapse}
              />
            )
          })}
        </ol>
      )}
    </div>
  )
}

const TimelineSlot = memo(function TimelineSlot({
  slotKey: key,
  item,
  sessionRunning,
  isFocused,
  collapsed,
  onToggleCollapse,
}: {
  slotKey: string
  item: TimelineItem
  sessionRunning: boolean
  isFocused: boolean
  collapsed: boolean
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
          collapsed={collapsed}
          onToggleCollapse={() => onToggleCollapse(key)}
          {...(isFocused ? { extraClassName: styles['timelineSlotFocused'] ?? '' } : {})}
        />
      )
  }
})

function slotKey(item: TimelineItem): string {
  switch (item.kind) {
    case 'message':
      return `m:${item.id}`
    case 'toolCall':
      return `t:${item.id}`
  }
}

// Per-kind default collapse under the `default` mode — mirrors the prior
// behaviour: thought messages and read/search tool calls start collapsed, the
// rest start expanded.
function defaultCollapsed(item: TimelineItem, mode: CollapseMode): boolean {
  if (mode === 'collapsed') return true
  if (mode === 'expanded') return false
  switch (item.kind) {
    case 'message':
      return item.message.role === 'thought'
    case 'toolCall':
      // Sub-agent parent cards (Task tool) fold by default so the nested
      // timeline stays out of the way until the user opens it.
      return (
        item.call.kind === 'read' ||
        item.call.kind === 'search' ||
        (item.call.children?.length ?? 0) > 0
      )
  }
}

// An explicit per-item override wins; otherwise fall back to the mode default.
function resolveCollapsed(key: string, item: TimelineItem, state: CollapseState): boolean {
  const override = state.overrides.get(key)
  return override !== undefined ? override : defaultCollapsed(item, state.mode)
}

function nextCollapseMode(mode: CollapseMode): CollapseMode {
  switch (mode) {
    case 'default':
      return 'collapsed'
    case 'collapsed':
      return 'expanded'
    case 'expanded':
      return 'default'
  }
}

// First non-empty line of a message, trimmed and clamped, for the collapsed
// single-line summary.
function firstLineSummary(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  const MAX = 120
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX)}…` : firstLine
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
