/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-view custom right-side toolbar widgets, keyed by view id. Rendered in the
 *  view's title bar (ViewPane header for multi-view containers, the container
 *  header for single-view ones) ahead of the MenuId.ViewTitle action buttons.
 *--------------------------------------------------------------------------------------------*/

import type { ComponentType } from 'react'
import { ExplorerViewToolbar } from '../explorer/ExplorerViewToolbar.js'
import { OutputViewToolbar } from '../panel/output/OutputViewToolbar.js'
import { TerminalViewToolbar } from '../panel/terminal/TerminalViewToolbar.js'
import { ScmViewToolbar } from '../scm/ScmViewToolbar.js'
import { AgentsViewToolbar } from '../agents/AgentsViewToolbar.js'
import { SearchViewToolbar } from '../search/SearchViewToolbar.js'

export const viewToolbarMap = new Map<string, ComponentType>([
  ['workbench.view.explorer.tree', ExplorerViewToolbar],
  ['workbench.view.output.main', OutputViewToolbar],
  ['workbench.view.terminal.main', TerminalViewToolbar],
  ['workbench.view.scm.main', ScmViewToolbar],
  ['workbench.view.agents.main', AgentsViewToolbar],
  ['workbench.view.search.results', SearchViewToolbar],
])
