/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  timelineIcons — maps a Timeline Item's kind (message role / tool-call kind /
 *  plan) to a compact lucide icon. The icon replaces the old text badges; the
 *  human-readable kind label is surfaced as a header tooltip by CollapsibleSlot.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import {
  Bot,
  Brain,
  CircleHelp,
  FilePen,
  FileText,
  FolderInput,
  Globe,
  ListChecks,
  Repeat,
  Search,
  Terminal,
  Trash2,
  User,
  Wrench,
} from 'lucide-react'
import type { AcpMessageRole } from '../../services/acp/acpSessionService.js'

const ICON_SIZE = 14

export function roleIcon(role: AcpMessageRole): ReactNode {
  switch (role) {
    case 'user':
      return <User size={ICON_SIZE} />
    case 'agent':
      return <Bot size={ICON_SIZE} />
    case 'thought':
      return <Brain size={ICON_SIZE} />
  }
}

export function toolKindIcon(kind: string): ReactNode {
  switch (kind) {
    case 'read':
      return <FileText size={ICON_SIZE} />
    case 'edit':
      return <FilePen size={ICON_SIZE} />
    case 'delete':
      return <Trash2 size={ICON_SIZE} />
    case 'move':
      return <FolderInput size={ICON_SIZE} />
    case 'search':
      return <Search size={ICON_SIZE} />
    case 'execute':
      return <Terminal size={ICON_SIZE} />
    case 'think':
      return <Brain size={ICON_SIZE} />
    case 'fetch':
      return <Globe size={ICON_SIZE} />
    case 'switch_mode':
      return <Repeat size={ICON_SIZE} />
    case 'other':
      return <Wrench size={ICON_SIZE} />
    default:
      return <CircleHelp size={ICON_SIZE} />
  }
}

export function planIcon(): ReactNode {
  return <ListChecks size={ICON_SIZE} />
}
