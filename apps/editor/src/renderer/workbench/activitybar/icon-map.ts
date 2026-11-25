import { FolderTree } from 'lucide-react'
import type { WorkbenchIcon } from '../icons/iconComponent.js'
import { resolveIcon } from '../icons/icon-map.js'

/**
 * Resolves the string `icon` field carried by `IViewContainerDescriptor` /
 * `IViewDescriptor` to a renderable glyph. Container icons keep their Lucide
 * glyphs; any other registered codicon renders from the codicon font. Only a
 * value that is not an icon reference at all (e.g. a file path) falls back to
 * the Explorer glyph.
 */
export function resolveActivityIcon(name: string): WorkbenchIcon {
  return resolveIcon(name) ?? FolderTree
}
