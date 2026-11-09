import type {
  MobileTimelineItem,
  MobileTimelineMessageItem,
  MobileTimelineNoticeItem,
  MobileTimelineToolCallItem,
} from '@universe-editor/mobile-protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownView } from '../markdown/MarkdownView.js'
import type { MobileClient } from '../state/mobileClient.js'
import { strings } from '../strings.js'
import { MessageAttachments } from './MessageAttachments.js'
import { selectTimelineForDisplay, type SessionDisplayPreference } from './sessionDisplay.js'
import { ToolCallGroup } from './ToolCallGroup.js'

const INITIAL_VISIBLE_ITEMS = 200
const LOAD_EARLIER_BATCH = 200
const BOTTOM_THRESHOLD_PX = 80

export interface TimelineProps {
  readonly sessionKey: string
  readonly timeline: readonly MobileTimelineItem[]
  readonly displayMode: SessionDisplayPreference
  readonly truncated: boolean
  readonly client: Pick<MobileClient, 'requestToolCallDetail' | 'fetchAttachmentBlob'>
}

type TimelineGroup =
  | { readonly type: 'item'; readonly item: MobileTimelineItem }
  | { readonly type: 'tools'; readonly items: readonly MobileTimelineToolCallItem[] }

export function Timeline({ sessionKey, timeline, displayMode, truncated, client }: TimelineProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ITEMS)
  const [showJump, setShowJump] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const displayTimeline = useMemo(
    () => selectTimelineForDisplay(timeline, displayMode),
    [timeline, displayMode],
  )

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_ITEMS)
    atBottomRef.current = true
    setShowJump(false)
  }, [sessionKey, displayMode])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    if (atBottomRef.current) {
      element.scrollTop = element.scrollHeight
      setShowJump(false)
    } else {
      setShowJump(true)
    }
  }, [timeline])

  const handleScroll = (): void => {
    const element = scrollRef.current
    if (element === null) return
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX
    atBottomRef.current = atBottom
    if (atBottom) setShowJump(false)
  }

  const jumpToLatest = (): void => {
    const element = scrollRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
    atBottomRef.current = true
    setShowJump(false)
  }

  const visible = displayTimeline.slice(Math.max(0, displayTimeline.length - visibleCount))
  const groups = groupTimeline(visible, displayMode === 'full')

  return (
    <div className="timeline-wrap">
      <div
        className="timeline-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="session-timeline"
      >
        {displayTimeline.length > visibleCount && (
          <button
            type="button"
            className="timeline-load-earlier"
            onClick={() => setVisibleCount((value) => value + LOAD_EARLIER_BATCH)}
          >
            {strings.loadEarlier}
          </button>
        )}
        {truncated && <div className="timeline-notice">{strings.sessionTruncated}</div>}
        {groups.map((group) =>
          group.type === 'tools' ? (
            <ToolCallGroup
              key={`tools:${group.items[0]?.id ?? ''}`}
              items={group.items}
              client={client}
            />
          ) : (
            <TimelineItem
              key={`${group.item.kind}:${group.item.id}`}
              item={group.item}
              client={client}
            />
          ),
        )}
      </div>
      {showJump && (
        <button type="button" className="jump-button" onClick={jumpToLatest}>
          {strings.jumpToLatest}
        </button>
      )}
    </div>
  )
}

function groupTimeline(items: readonly MobileTimelineItem[], groupTools: boolean): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  let pendingTools: MobileTimelineToolCallItem[] = []
  const flushTools = (): void => {
    if (pendingTools.length === 0) return
    groups.push({ type: 'tools', items: pendingTools })
    pendingTools = []
  }
  for (const item of items) {
    if (groupTools && item.kind === 'toolCall') {
      pendingTools.push(item)
      continue
    }
    flushTools()
    groups.push({ type: 'item', item })
  }
  flushTools()
  return groups
}

function TimelineItem({
  item,
  client,
}: {
  readonly item: MobileTimelineItem
  readonly client: Pick<MobileClient, 'requestToolCallDetail' | 'fetchAttachmentBlob'>
}) {
  switch (item.kind) {
    case 'message':
      return <MessageItem item={item} client={client} />
    case 'notice':
      return <NoticeItem item={item} />
    case 'toolCall':
      return <ToolCallGroup items={[item]} client={client} />
  }
}

function MessageItem({
  item,
  client,
}: {
  readonly item: MobileTimelineMessageItem
  readonly client: Pick<MobileClient, 'fetchAttachmentBlob'>
}) {
  if (item.memoryTrimmed === true) {
    return <div className="timeline-notice">{strings.memoryTrimmed}</div>
  }
  if (item.role === 'user') {
    return (
      <div className="message message--user" data-testid="user-message">
        {item.attachments !== undefined && item.attachments.length > 0 && (
          <MessageAttachments attachments={item.attachments} client={client} />
        )}
        {item.text !== '' && <p className="message__text">{item.text}</p>}
        {item.hasNonText === true && <p className="muted-note">{strings.messageNonText}</p>}
      </div>
    )
  }
  if (item.role === 'thought') return <ThoughtItem item={item} />
  return (
    <div className="message message--agent" data-testid="agent-message">
      <MarkdownView text={item.text} testId="agent-markdown" />
      {item.hasNonText === true && <p className="muted-note">{strings.messageNonText}</p>}
      {item.streaming && <span className="streaming-cursor" aria-hidden="true" />}
    </div>
  )
}

function ThoughtItem({ item }: { readonly item: MobileTimelineMessageItem }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="thought" data-testid="thought-item">
      <button
        type="button"
        className="thought__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="thought__title">{strings.thoughtTitle}</span>
        {item.streaming && <span className="streaming-cursor" aria-hidden="true" />}
        <span className="thought__chevron" aria-hidden="true">
          {expanded ? '▴' : '▾'}
        </span>
        <span className="visually-hidden">
          {expanded ? strings.thoughtCollapse : strings.thoughtExpand}
        </span>
      </button>
      {expanded && (
        <div className="thought__body">
          <MarkdownView text={item.text} />
        </div>
      )}
    </section>
  )
}

function NoticeItem({ item }: { readonly item: MobileTimelineNoticeItem }) {
  const text = item.text ?? noticeText(item.noticeKind)
  return <div className="timeline-notice">{text}</div>
}

function noticeText(kind: MobileTimelineNoticeItem['noticeKind']): string {
  switch (kind) {
    case 'compaction':
      return strings.noticeCompaction
    case 'resurrection':
      return strings.noticeResurrection
  }
}
