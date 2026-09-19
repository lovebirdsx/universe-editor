/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ToolCallLocations — renders a tool call's affected files (`AcpToolCall.locations`)
 *  as clickable links. Used on cards that touched files but carry no diff of their
 *  own (read / search / memory); a click opens the file, at `line` when reported,
 *  via the shared file opener passed in by the parent.
 *--------------------------------------------------------------------------------------------*/

import { FileText } from 'lucide-react'
import type { AcpToolCallLocation } from '../../services/acp/session/acpSessionService.js'
import styles from './agents.module.css'

/** Basename for the link label; the full path stays in the tooltip. */
function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter((s) => s.length > 0)
  return parts[parts.length - 1] ?? path
}

export function ToolCallLocations({
  locations,
  onOpen,
  resolveUri,
}: {
  readonly locations: readonly AcpToolCallLocation[]
  readonly onOpen: (location: AcpToolCallLocation) => void
  /**
   * Resolved URI for a reported path, stamped as `data-uri` so the chat context
   * menu can copy the path. Only this attribute is added — clicking still goes
   * through {@link onOpen}, whose opener probes the filesystem for the file.
   */
  readonly resolveUri?: ((path: string) => string | undefined) | undefined
}) {
  if (locations.length === 0) return null
  return (
    <div className={styles['toolCallLocations']} data-testid="acp-toolcall-locations">
      {locations.map((loc, i) => {
        const uri = resolveUri?.(loc.path)
        return (
          <button
            key={`${loc.path}-${i}`}
            type="button"
            className={styles['toolCallLocation']}
            onClick={() => onOpen(loc)}
            data-tooltip={loc.line !== undefined ? `${loc.path}:${loc.line}` : loc.path}
            data-testid="acp-toolcall-location"
            {...(uri !== undefined ? { 'data-uri': uri } : {})}
          >
            <FileText size={12} strokeWidth={1.75} aria-hidden="true" />
            <span className={styles['toolCallLocationLabel']}>
              {basename(loc.path)}
              {loc.line !== undefined && (
                <span className={styles['toolCallLocationLine']}>:{loc.line}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
