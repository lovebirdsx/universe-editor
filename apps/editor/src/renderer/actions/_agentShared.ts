/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared building blocks for the agent (ACP) Action2 definitions, split across
 *  agentSessionActions / agentModelActions / agentSettingsActions /
 *  agentTimelineActions. Keep cross-file helpers here; helpers used by a single
 *  group live next to that group.
 *--------------------------------------------------------------------------------------------*/

import { IEditorService, localize2, type ServicesAccessor } from '@universe-editor/platform'
import { IAcpChatWidgetService, type AcpChatWidget } from '../services/acp/acpChatWidgetService.js'
import { AcpSessionEditorInput } from '../services/acp/acpSessionEditorInput.js'

export const CATEGORY = localize2('command.category.agents', 'Agents')

// Gate for session-scoped navigation commands (timeline move/scroll, collapse,
// find-open, font, copy). The chat widget can be driven two ways:
//   - DOM focus is inside a chat container (sidebar ChatPanel or an editor whose
//     timeline the user clicked) → `acpChatFocused`.
//   - the active editor is a session editor AND focus is somewhere in the editor
//     area (notably a read-only foreign session, which auto-focuses the editor
//     group body rather than a chat input) → `editorAreaFocus && activeEditorTypeId`.
// The `editorAreaFocus` conjunct is what keeps these keys from firing when the
// active editor merely *happens* to be a session while focus sits elsewhere — the
// command palette, a focused terminal/panel, or a sidebar view. `activeEditorTypeId`
// (NOT the group-scoped `activeEditorType` used by the editor title menus) is the
// root context key that global keybinding resolution can see.
export const ACP_NAV_WHEN = `acpChatFocused || (editorAreaFocus && activeEditorTypeId == '${AcpSessionEditorInput.TYPE_ID}')`

// Resolve which chat widget a session command should target. Prefer the widget
// behind the active session editor (so commands work even when DOM focus never
// landed in its timeline); otherwise fall back to whichever chat last held focus
// (the sidebar case, and any non-editor focus path).
export function resolveNavWidget(accessor: ServicesAccessor): AcpChatWidget | undefined {
  const widgets = accessor.get(IAcpChatWidgetService)
  const active = accessor.get(IEditorService).activeEditor.get()
  if (active instanceof AcpSessionEditorInput) {
    const w = widgets.widgetForSession(active.sessionId)
    if (w) return w
  }
  return widgets.lastFocusedWidget
}
