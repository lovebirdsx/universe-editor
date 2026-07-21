/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ToolCallLocations — renders a tool call's affected files (`AcpToolCall.locations`)
 *  as clickable links. Used on cards that touched files but carry no diff of their
 *  own (read / search / memory); a click opens the file, at `line` when reported,
 *  via the shared file opener passed in by the parent.
 *--------------------------------------------------------------------------------------------*/

import { FileText } from 'lucide-react'
import type { AcpToolCallLocation } from '../../services/acp/acpSessionService.js'
import styles from './agents.module.css'

/** Basename for the link label; the full path stays in the tooltip. */
function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter((s) => s.length > 0)
  return parts[parts.length - 1] ?? path
}

export function ToolCallLocations({
  locations,
  onOpen,
}: {
  readonly locations: readonly AcpToolCallLocation[]
  readonly onOpen: (location: AcpToolCallLocation) => void
}) {
  if (locations.length === 0) return null
  return (
    <div className={styles['toolCallLocations']} data-testid="acp-toolcall-locations">
      {locations.map((loc, i) => (
        <button
          key={`${loc.path}-${i}`}
          type="button"
          className={styles['toolCallLocation']}
          onClick={() => onOpen(loc)}
          title={loc.line !== undefined ? `${loc.path}:${loc.line}` : loc.path}
          data-testid="acp-toolcall-location"
        >
          <FileText size={12} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles['toolCallLocationLabel']}>
            {basename(loc.path)}
            {loc.line !== undefined && (
              <span className={styles['toolCallLocationLine']}>:{loc.line}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  )
}
