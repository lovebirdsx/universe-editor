/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AgentsView — the single AGENTS view that lives in SecondarySideBar. Picks
 *  between the SessionListPanel (when Chat is parked in EditorArea) and the
 *  full-fat ChatPanel (when the user moves Chat into the sidebar). The choice
 *  is driven by IAcpChatLocationService, which persists across restarts and
 *  exposes a ContextKey for Action `when` clauses.
 *--------------------------------------------------------------------------------------------*/

import { useObservable, useService } from '../useService.js'
import { IAcpChatLocationService } from '../../services/acp/acpChatLocationService.js'
import { ChatPanel } from './ChatPanel.js'
import { SessionListPanel } from './SessionListPanel.js'

export function AgentsView() {
  const location = useService(IAcpChatLocationService)
  const value = useObservable(location.location)
  return value === 'sidebar' ? <ChatPanel /> : <SessionListPanel />
}
