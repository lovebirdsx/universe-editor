/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The workbench's icon-id → glyph table. `icon` identifiers travel through the
 *  app as opaque strings (Action2's `icon`, IMenuItem.icon, IViewDescriptor.icon,
 *  a TreeItem's iconPath, an extension manifest's `contributes.menus[].icon`) and
 *  are resolved to a concrete component here, at render time. Container icons
 *  come from the shared {@link CONTAINER_ICON_MAP}; everything else is defined
 *  below.
 *
 *  Ids follow codicon naming (VSCode parity) even though the glyphs are Lucide.
 *  An unknown id resolves to `undefined` and the caller silently renders nothing,
 *  so a typo is a no-op rather than an error — `__tests__/iconCoverage.test.ts`
 *  is what turns that back into a failure.
 *--------------------------------------------------------------------------------------------*/

import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ArrowUpToLine,
  AppWindow,
  Ban,
  Bell,
  Bookmark,
  Braces,
  Check,
  Cherry,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  CircleHelp,
  CircleStop,
  CircleX,
  ClipboardPaste,
  Cloud,
  CloudDownload,
  Columns2,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileDiff,
  FileJson,
  FileOutput,
  FilePlus,
  Files,
  FileSymlink,
  Focus,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  FolderTree,
  GitBranch,
  GitBranchPlus,
  GitGraph,
  GitMerge,
  History,
  Keyboard,
  KeyRound,
  List,
  ListChecks,
  ListMinus,
  ListPlus,
  ListX,
  LocateFixed,
  LogOut,
  Minus,
  MoreHorizontal,
  Move,
  OctagonX,
  Package,
  Pin,
  PinOff,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Scissors,
  Shield,
  SquarePen,
  Tag,
  Trash2,
  Undo2,
  Unplug,
  X,
  type LucideIcon,
} from 'lucide-react'
import { CONTAINER_ICON_MAP } from './containerIcons.js'

const ICON_MAP: Record<string, LucideIcon> = {
  ...CONTAINER_ICON_MAP,
  'trash-2': Trash2,
  check: Check,
  refresh: RefreshCw,
  // SCM / Git actions and view controls.
  'git-commit': Check,
  'git-graph': GitGraph,
  history: History,
  add: Plus,
  remove: Minus,
  discard: Undo2,
  'go-to-file': FileSymlink,
  'stage-all': ListPlus,
  'unstage-all': ListMinus,
  'discard-all': Undo2,
  // Perforce SCM actions.
  archive: Archive,
  'arrow-right': ArrowRight,
  'arrow-left': ArrowLeft,
  'arrow-down': ArrowDown,
  'new-file': FilePlus,
  export: FileOutput,
  edit: SquarePen,
  trash: Trash2,
  key: KeyRound,
  'sign-out': LogOut,
  'arrow-swap': ArrowLeftRight,
  // SCM resource-group header icons (by group kind).
  changelist: ListChecks,
  pull: ArrowDown,
  push: ArrowUp,
  sync: RefreshCw,
  fetch: Download,
  'cloud-download': CloudDownload,
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
  'expand-all': ChevronsUpDown,
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
  // Quick pick item buttons (command palette "remove from recently used").
  x: X,
  // Clipboard and file management (Explorer / editor context menus).
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
  duplicate: CopyPlus,
  'find-in-folder': FolderSearch,
  'open-with': ExternalLink,
  reveal: FolderOpen,
  'folder-opened': FolderOpen,
  focus: Focus,
  // Editor tabs.
  close: X,
  'reopen-with': Files,
  // Remote Explorer.
  connect: Plug,
  disconnect: Unplug,
  retry: RotateCw,
  'stop-server': CircleStop,
  // Process Explorer.
  kill: CircleX,
  'force-kill': OctagonX,
  // Keyboard Shortcuts editor.
  reset: RotateCcw,
  keyboard: Keyboard,
  when: Braces,
  // Agent session list.
  pin: Pin,
  'pin-off': PinOff,
  'archive-restore': ArchiveRestore,
  // Commit graph.
  'cherry-pick': Cherry,
  // Outline "Go to" submenu.
  'go-to-definition': LocateFixed,
  // Extensions list.
  disable: Ban,
  // Numbered Bookmarks extension.
  bookmark: Bookmark,
  'clear-all': ListX,
  // Status bar entries.
  bell: Bell,
  shield: Shield,
}

export function resolveIcon(name: string | undefined): LucideIcon | undefined {
  if (!name) return undefined
  return ICON_MAP[name]
}

/** The registered ids, for the coverage test that guards against typos. */
export function isKnownIcon(name: string): boolean {
  return name in ICON_MAP
}
