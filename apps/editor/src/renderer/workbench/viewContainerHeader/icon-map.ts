import {
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  AppWindow,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronUp,
  CircleHelp,
  Cloud,
  Columns2,
  Download,
  Eye,
  EyeOff,
  FileDiff,
  FileJson,
  FileSymlink,
  FolderGit2,
  FolderPlus,
  FolderTree,
  GitBranch,
  GitBranchPlus,
  GitGraph,
  GitMerge,
  List,
  ListChecks,
  ListMinus,
  ListPlus,
  Minus,
  MoreHorizontal,
  Move,
  Package,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import { CONTAINER_ICON_MAP } from '../icons/containerIcons.js'

/**
 * Unified icon resolver shared by ViewContainerHeader (left container icons +
 * right command icons). Container icons come from the shared
 * {@link CONTAINER_ICON_MAP}; command icons (MenuId.ViewTitle actions, set via
 * Action2's `icon`) are defined locally below.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  ...CONTAINER_ICON_MAP,
  'trash-2': Trash2,
  check: Check,
  refresh: RefreshCw,
  // SCM / Git actions and view controls.
  'git-commit': Check,
  'git-graph': GitGraph,
  add: Plus,
  remove: Minus,
  discard: Undo2,
  'go-to-file': FileSymlink,
  'stage-all': ListPlus,
  'unstage-all': ListMinus,
  'discard-all': Undo2,
  pull: ArrowDown,
  push: ArrowUp,
  sync: RefreshCw,
  fetch: Download,
  checkout: GitBranch,
  'create-branch': GitBranchPlus,
  'git-worktree': FolderGit2,
  'new-folder': FolderPlus,
  'empty-window': AppWindow,
  merge: GitMerge,
  stash: Archive,
  remote: Cloud,
  tag: Tag,
  'git-submodule': Package,
  'list-view': List,
  'tree-view': FolderTree,
  'collapse-all': ChevronsDownUp,
  more: MoreHorizontal,
  move: Move,
  // Editor title actions.
  'open-preview': Eye,
  'open-preview-side': Columns2,
  help: CircleHelp,
  'json-schema': FileJson,
  // Simple file dialog — toggle hidden files.
  eye: Eye,
  'eye-off': EyeOff,
  // Agent session editor — timeline navigation.
  'go-to-plan': ListChecks,
  'timeline-prev': ChevronUp,
  'timeline-next': ChevronDown,
  'timeline-top': ArrowUpToLine,
  'timeline-bottom': ArrowDownToLine,
  'compare-changes': FileDiff,
  'diff-previous-change': ArrowUp,
  'diff-next-change': ArrowDown,
}

export function resolveHeaderIcon(name: string | undefined): LucideIcon | undefined {
  if (!name) return undefined
  return ICON_MAP[name]
}
