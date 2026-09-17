/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared building blocks for the agent (ACP) Action2 definitions, split across
 *  agentSessionActions / agentModelActions / agentSettingsActions /
 *  agentTimelineActions. Keep cross-file helpers here; helpers used by a single
 *  group live next to that group.
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorService,
  KeybindingWeight,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IAcpChatWidgetService,
  type AcpChatWidget,
} from '../services/acp/session/acpChatWidgetService.js'
import { AcpSessionEditorInput } from '../services/acp/session/acpSessionEditorInput.js'
import { basenameOfPath } from '../workbench/files/resourceInfo.js'

export const CATEGORY = localize2('command.category.agents', 'Agents')

/** Trailing segment of a session's cwd, for disambiguating same-titled rows. */
export function sessionDirectoryName(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined
  const normalized = cwd.replace(/[\\/]+$/, '')
  if (normalized.length === 0) return cwd
  const name = basenameOfPath(normalized)
  return name.length > 0 ? name : cwd
}

// The prompt-suggestion popover, in-session find, and turn-cancel bind keys that
// would otherwise hit Monaco / global bindings (down/up/tab/enter/escape/f3).
// Registering them above the default WorkbenchContrib guarantees the scoped
// binding wins whenever its ContextKey is set, independent of registration order.
export const ACP_SCOPED_KEY_WEIGHT = KeybindingWeight.WorkbenchContrib + 50

// Gate for session-scoped navigation commands (timeline move/scroll, collapse,
// find-open, font, copy). Focus reaches a chat timeline two ways:
//   - DOM focus is inside the chat container (the user clicked the timeline, or
//     the session editor auto-focused its input) → `acpChatFocused`.
//   - the active editor is a session editor AND focus is somewhere in the editor
//     area (notably a read-only foreign session, which auto-focuses the editor
//     group body rather than a chat input) → `editorAreaFocus && activeEditorTypeId`.
// The `editorAreaFocus` conjunct is what keeps these keys from firing when the
// active editor merely *happens* to be a session while focus sits elsewhere — the
// command palette, a focused terminal/panel, or a sidebar view. `activeEditorTypeId`
// (NOT the group-scoped `activeEditorType` used by the editor title menus) is the
// root context key that global keybinding resolution can see.
export const ACP_NAV_WHEN = `acpChatFocused || (editorAreaFocus && activeEditorTypeId == '${AcpSessionEditorInput.TYPE_ID}')`

// Stricter gate for keys that address the session *editor*'s config bar by
// position (Alt+<n>): they must resolve against the editor in front, so a chat
// widget that merely held focus last can never answer them.
export const ACP_EDITOR_ONLY_WHEN = `editorAreaFocus && activeEditorTypeId == '${AcpSessionEditorInput.TYPE_ID}'`

// Resolve which chat widget a session command should target. Prefer the widget
// behind the active session editor (so commands work even when DOM focus never
// landed in its timeline); otherwise fall back to whichever chat last held focus.
export function resolveNavWidget(accessor: ServicesAccessor): AcpChatWidget | undefined {
  const widgets = accessor.get(IAcpChatWidgetService)
  const active = accessor.get(IEditorService).activeEditor.get()
  if (active instanceof AcpSessionEditorInput) {
    const w = widgets.widgetForSession(active.sessionId)
    if (w) return w
  }
  return widgets.lastFocusedWidget
}

// ...and the strict variant for keys gated on ACP_EDITOR_ONLY_WHEN. There the
// last-focused fallback is actively wrong: between an editor becoming active and
// its widget registering (ChatBody registers on mount), it would hand the key to
// another session's chat — exactly what the gate exists to keep out. A session
// editor with no widget yet simply has no target.
export function resolveEditorNavWidget(accessor: ServicesAccessor): AcpChatWidget | undefined {
  const active = accessor.get(IEditorService).activeEditor.get()
  if (!(active instanceof AcpSessionEditorInput)) return undefined
  return accessor.get(IAcpChatWidgetService).widgetForSession(active.sessionId)
}
