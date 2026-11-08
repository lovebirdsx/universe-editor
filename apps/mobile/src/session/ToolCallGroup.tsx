import type { MobileTimelineToolCallItem } from '@universe-editor/mobile-protocol'
import { useState } from 'react'
import type { MobileClient } from '../state/mobileClient.js'
import { strings } from '../strings.js'
import { ToolCallRow } from './ToolCallRow.js'

export interface ToolCallGroupProps {
  readonly items: readonly MobileTimelineToolCallItem[]
  readonly client: Pick<MobileClient, 'requestToolCallDetail'>
}

export function ToolCallGroup({ items, client }: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 1) {
    const item = items[0]
    if (item === undefined) return null
    return <ToolCallRow item={item} client={client} />
  }
  const failed = items.some((item) => item.status === 'failed')
  return (
    <section className="tool-group" data-testid="tool-call-group">
      <button
        type="button"
        className="tool-group__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tool-group__icon" aria-hidden="true">
          ⚙
        </span>
        <span className="tool-group__title">{strings.toolCallGroupTitle(items.length)}</span>
        {failed && (
          <span className="tool-group__failed" aria-label={strings.bucketFailed}>
            ✕
          </span>
        )}
        <span className="tool-group__chevron" aria-hidden="true">
          {expanded ? '▴' : '▾'}
        </span>
      </button>
      {expanded && (
        <div className="tool-group__items">
          {items.map((item) => (
            <ToolCallRow key={item.id} item={item} client={client} />
          ))}
        </div>
      )}
    </section>
  )
}
