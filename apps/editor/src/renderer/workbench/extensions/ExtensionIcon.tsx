/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionIcon — renders an extension's icon: the real marketplace icon (a
 *  data: URL fetched by main) when available, otherwise a semantic fallback
 *  chosen per extension id. Built-in extensions ship no icon field, so the id
 *  mapping is what gives git / typescript / markdown / … distinct glyphs instead
 *  of a single generic Package icon.
 *--------------------------------------------------------------------------------------------*/

import {
  Bookmark,
  Bot,
  FileCode,
  FileText,
  GitBranch,
  Hash,
  Package,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { useExtensionIcon } from './useExtensionIcon.js'
import type { IExtensionEntry } from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'

/** Ordered id → glyph rules; first match wins, Package is the catch-all. */
const ICON_RULES: ReadonlyArray<readonly [test: (id: string) => boolean, icon: LucideIcon]> = [
  [(id) => id.endsWith('/git') || id.endsWith('.git'), GitBranch],
  [(id) => id.includes('typescript'), FileCode],
  [(id) => id.includes('markdown'), Hash],
  [(id) => id.includes('claude'), Bot],
  [(id) => id.endsWith('/ai') || id.endsWith('.ai'), Sparkles],
  [(id) => id.includes('bookmark'), Bookmark],
  [(id) => id.includes('pdf'), FileText],
]

export function extensionFallbackIcon(id: string): LucideIcon {
  return ICON_RULES.find(([test]) => test(id))?.[1] ?? Package
}

/** The `img` is `size`; the fallback glyph is drawn slightly smaller to match. */
export function ExtensionIcon({ entry, size }: { entry: IExtensionEntry; size: number }) {
  const iconUrl = useExtensionIcon(entry)
  if (iconUrl) return <img src={iconUrl} alt="" width={size} height={size} />
  const Icon = extensionFallbackIcon(entry.id)
  return <Icon size={Math.round(size * 0.875)} />
}
