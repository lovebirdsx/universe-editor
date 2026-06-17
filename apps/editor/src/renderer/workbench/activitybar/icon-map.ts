import { FolderTree, type LucideIcon } from 'lucide-react'
import { CONTAINER_ICON_MAP } from '../icons/containerIcons.js'

/**
 * Resolves the string `icon` field carried by `IViewContainerDescriptor` /
 * `IViewDescriptor` to a concrete lucide-react component. Container icons live in
 * the shared {@link CONTAINER_ICON_MAP} so the glyph stays stable across the
 * ActivityBar and the PaneCompositeHeader tabs.
 */
export function resolveActivityIcon(name: string): LucideIcon {
  return CONTAINER_ICON_MAP[name] ?? FolderTree
}
