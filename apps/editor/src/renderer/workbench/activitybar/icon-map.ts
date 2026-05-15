import {
  FolderTree,
  Search,
  GitPullRequest,
  Bug,
  Puzzle,
  Settings,
  type LucideIcon,
} from 'lucide-react'

/**
 * Maps the string `icon` field carried by `IViewContainerDescriptor` (registered
 * in `@universe-editor/platform`) to a concrete lucide-react component.
 *
 * The platform layer stays free of any icon-library dependency — the renderer
 * resolves names here so swapping icon sets later only touches this file.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  files: FolderTree,
  search: Search,
  'git-pull-request': GitPullRequest,
  'debug-alt': Bug,
  extensions: Puzzle,
  'settings-gear': Settings,
}

export function resolveActivityIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? FolderTree
}
