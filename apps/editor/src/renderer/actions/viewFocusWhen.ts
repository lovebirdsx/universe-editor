/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  viewFocusWhen — build the when-clause that scopes a keybinding to "this view
 *  owns keyboard focus".
 *
 *  `focusedView` is a root context key seeded by FocusContextKeyContribution from
 *  the focused element's nearest `data-view-id` ancestor — views never set it
 *  themselves. Every scoped binding was hand-writing the same comparison, and
 *  two of them had drifted into a copy of the whole literal.
 *
 *  `extra` is deliberately explicit rather than defaulted: Explorer's bindings
 *  additionally require `!editorTextFocus && !terminalFocus`, while Outline's and
 *  Swarm's do not. Appending that guard for everyone would silently change two
 *  keybinding scopes, so each call site states what it needs.
 *--------------------------------------------------------------------------------------------*/

export function viewFocusWhen(viewId: string, extra?: string): string {
  return `focusedView == '${viewId}'${extra ? ` && ${extra}` : ''}`
}
