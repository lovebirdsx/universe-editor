/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single source of truth for ViewContainer icons. Both the ActivityBar (SideBar
 *  container icons) and the PaneCompositeHeader tabs (Panel / Secondary Side Bar)
 *  resolve container icons here, so a container keeps the same glyph wherever it
 *  is dragged. The string keys are the `icon` identifiers carried by
 *  IViewContainerDescriptor and IViewDescriptor.
 *--------------------------------------------------------------------------------------------*/

import {
  AppWindow,
  Bug,
  FileDiff,
  FolderTree,
  GitBranch,
  GitPullRequest,
  ListTree,
  Puzzle,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  Terminal,
  type LucideIcon,
} from 'lucide-react'

export const CONTAINER_ICON_MAP: Record<string, LucideIcon> = {
  files: FolderTree,
  search: Search,
  'source-control': GitBranch,
  'git-pull-request': GitPullRequest,
  'debug-alt': Bug,
  extensions: Puzzle,
  'settings-gear': Settings,
  diff: FileDiff,
  outline: ListTree,
  output: SquareTerminal,
  terminal: Terminal,
  sparkle: Sparkles,
  window: AppWindow,
}
