/*---------------------------------------------------------------------------------------------
 *  notificationSeverityIcon — per-severity glyph shared by the toast stack and
 *  the notification center. The error glyph deliberately avoids an ✕ shape
 *  (filled disc with an exclamation mark instead) so it can't be mistaken for
 *  the dismiss button sitting at the item's right edge.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import { Severity } from '@universe-editor/platform'

export function notificationSeverityClass(severity: Severity): string {
  if (severity === Severity.Error) return 'severity-error'
  if (severity === Severity.Warning) return 'severity-warning'
  return 'severity-info'
}

export function notificationSeverityIcon(severity: Severity): ReactNode {
  if (severity === Severity.Error) {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M8 4.4v4.4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="11.6" r="1" fill="#fff" />
      </svg>
    )
  }
  if (severity === Severity.Warning) return '⚠'
  return 'ℹ'
}
