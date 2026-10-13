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
import { resolveIcon } from '../icons/icon-map.js'
import { renderSymbolIconById } from '../symbols/symbolIcon.js'

/** Matched to the menu glyphs the same ids render as elsewhere. */
const STROKE = 1.6

/** Render the icon for a context suggestion `iconId`. Falls back to a docs glyph. */
export function renderContextIcon(iconId: string, size: number): ReactNode {
  const parsed = parseResourceIconId(iconId)
  if (parsed) {
    return <FileIcon resource={parsed.resource} isDirectory={parsed.isDirectory} size={size} />
  }
  const symbolIcon = renderSymbolIconById(iconId, size)
  if (symbolIcon) return symbolIcon
  // Extension-contributed entries name their icon with a workbench icon id (the
  // same table menus use), so resolve that before giving up.
  const Glyph = resolveIcon(iconId)
  if (Glyph) return <Glyph size={size} strokeWidth={STROKE} />
  return <BookOpen size={size} />
}
