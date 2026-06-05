import {
  ArrowDown,
  ArrowUp,
  Bug,
  Check,
  ChevronsDownUp,
  FolderTree,
  GitBranch,
  GitBranchPlus,
  GitPullRequest,
  List,
  ListMinus,
  ListPlus,
  ListTree,
  Minus,
  MoreHorizontal,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  Terminal,
  Trash2,
  Undo2,
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
  // SCM / Git actions and view controls.
  'git-commit': Check,
  add: Plus,
  remove: Minus,
  discard: Undo2,
  'stage-all': ListPlus,
  'unstage-all': ListMinus,
  'discard-all': Trash2,
  pull: ArrowDown,
  push: ArrowUp,
  sync: RefreshCw,
  checkout: GitBranch,
  'create-branch': GitBranchPlus,
  'list-view': List,
  'tree-view': FolderTree,
  'collapse-all': ChevronsDownUp,
  more: MoreHorizontal,
}

export function resolveHeaderIcon(name: string | undefined): LucideIcon | undefined {
  if (!name) return undefined
  return ICON_MAP[name]
}
