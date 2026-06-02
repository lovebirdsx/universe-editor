/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared session-title formatting. Single source of truth for the tab label
 *  truncation, reused by notifications so both stay visually consistent.
 *--------------------------------------------------------------------------------------------*/

export const MAX_TITLE_LEN = 24

export function truncateTitle(s: string): string {
  if (s.length <= MAX_TITLE_LEN) return s
  return `${s.slice(0, MAX_TITLE_LEN - 1)}…`
}
