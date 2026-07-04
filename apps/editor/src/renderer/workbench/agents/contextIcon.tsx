/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolves a `#`-context suggestion's `iconId` to a rendered icon for the
 *  ContextPopover, mirroring QuickInput's icon resolver chain: resource icons
 *  (file-type theme) → symbol-kind glyphs → docs fallback.
 *--------------------------------------------------------------------------------------------*/

import { BookOpen } from 'lucide-react'
import type { ReactNode } from 'react'
import { parseResourceIconId } from '../../services/quickInput/quickPickResourceIcon.js'
import { FileIcon } from '../files/fileIconTheme.js'
import { renderSymbolIconById } from '../symbols/symbolIcon.js'

/** Render the icon for a context suggestion `iconId`. Falls back to a docs glyph. */
export function renderContextIcon(iconId: string, size: number): ReactNode {
  const parsed = parseResourceIconId(iconId)
  if (parsed) {
    return <FileIcon resource={parsed.resource} isDirectory={parsed.isDirectory} size={size} />
  }
  const symbolIcon = renderSymbolIconById(iconId, size)
  if (symbolIcon) return symbolIcon
  return <BookOpen size={size} />
}
