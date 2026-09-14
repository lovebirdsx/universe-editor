/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  workbenchEditorFactory — the single place a workbench code editor is built.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from './MonacoLoader.js'

// ---------------------------------------------------------------------------
// Why this exists (monaco-editor 0.55.1)
//
// Monaco's editor-content widgets — hover, suggest + its details pane, parameter
// hints, the rename box, glyph hover, the inline message, the post-edit widget —
// all set `allowEditorOverflow`. With `fixedOverflowWidgets: false`, monaco's
// standalone default, `contentWidgets.js` positions them `absolute` against the
// editor's own DOM node: their containing block is `.monaco-editor`, but every
// `overflow: hidden | auto` ancestor still clips them. The nearest one here is
// the workbench's `.editorContent { overflow: auto }`, so a git-blame hover at
// the end of a long line is sliced off at the editor-group border instead of
// spilling over the group next to it.
//
// With the flag on the same widgets become `position: fixed`: coordinates turn
// viewport-relative and monaco clamps horizontally against the *window*
// (`_layoutBoxInPage` + `_layoutHorizontalSegmentInPage`), which is the contract
// `monacoWorkbenchLayoutService` already established for monaco's platform-level
// overlays (hover service, context view, action widget, quick input) — the
// workbench root is the window client area, so overlays are laid out against it.
// Monaco itself hard-codes the same flag for diff editors
// (`diffEditorEditors.js`), multi-diff items and the references peek, so diff
// editors in this app have always behaved this way; only our plain
// `editor.create` calls were missing it.
//
// `createDiffEditor` call sites deliberately keep using the plain monaco API:
// the diff editor forces the flag onto its own inner editors, so routing them
// through here would change nothing.
// ---------------------------------------------------------------------------

const FIXED_OVERFLOW_WIDGETS = { fixedOverflowWidgets: true } as const

/**
 * Creates a code editor with the workbench's overlay contract applied.
 *
 * Use this instead of `monacoNs.editor.create(...)` anywhere in the renderer —
 * the factory is the only thing keeping editor-content overlays unclipped, and
 * `workbenchEditorFactory.test.ts` fails the build if a bare `editor.create`
 * reappears. `overrides` stays optional and is passed through untouched so
 * callers keep monaco's standalone defaults when they never opted in.
 */
export function createWorkbenchEditor(
  monacoNs: typeof monaco,
  container: HTMLElement,
  options: monaco.editor.IStandaloneEditorConstructionOptions,
  overrides?: monaco.editor.IEditorOverrideServices,
): monaco.editor.IStandaloneCodeEditor {
  return monacoNs.editor.create(
    container,
    // Ours goes last so neither the caller nor `buildBridgedEditorOptions`
    // (which spreads every registered `editor.*` setting) can turn it back off.
    { ...options, ...FIXED_OVERFLOW_WIDGETS },
    overrides,
  )
}
