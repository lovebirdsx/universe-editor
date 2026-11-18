/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Status-bar glyphs for Vim mode. Lucide has no Vim mark, so these draw a
 *  compact "N"/"I" badge that stays legible at 14px and inherits the entry
 *  color (`currentColor`).
 *--------------------------------------------------------------------------------------------*/

import { forwardRef } from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react'

function createVimBadge(letterPath: string, displayName: string): LucideIcon {
  const Badge = forwardRef<SVGSVGElement, LucideProps>(function VimBadge(
    { size = 24, strokeWidth = 2, ...props },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        <rect x="2" y="5" width="20" height="14" rx="2.5" />
        <path d={letterPath} />
      </svg>
    )
  })
  Badge.displayName = displayName
  return Badge as unknown as LucideIcon
}

export const VimNormalIcon = createVimBadge('M8 15V9l8 6V9', 'VimNormalIcon')
export const VimInsertIcon = createVimBadge('M12 9v6M9 9h6M9 15h6', 'VimInsertIcon')
