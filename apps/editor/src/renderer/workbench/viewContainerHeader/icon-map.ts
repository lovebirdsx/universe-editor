import {
  Bug,
  FolderTree,
  GitPullRequest,
  ListTree,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  Terminal,
  Trash2,
  type LucideIcon,
} from 'lucide-react'

/**
 * Unified icon resolver shared by ViewContainerHeader (left container icons +
 * right command icons). Keys are the string `icon` identifiers carried by
 * `IViewContainerDescriptor` and by `IMenuItem.icon` (set via Action2's `icon`).
 */
const ICON_MAP: Record<string, LucideIcon> = {
  files: FolderTree,
  search: Search,
  'git-pull-request': GitPullRequest,
  'debug-alt': Bug,
  extensions: Puzzle,
  'settings-gear': Settings,
  output: SquareTerminal,
  terminal: Terminal,
  outline: ListTree,
  sparkle: Sparkles,
  'trash-2': Trash2,
  refresh: RefreshCw,
}

export function resolveHeaderIcon(name: string | undefined): LucideIcon | undefined {
  if (!name) return undefined
  return ICON_MAP[name]
}
