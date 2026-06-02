/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoUnicodeHighlighterPatch — pure transform applied to monaco-editor's
 *  `unicodeHighlighter.js`. It guards `UnicodeHighlighter._updateState` so the
 *  async worker callback bails out once the editor has lost its model (i.e. the
 *  editor was disposed). Because we share a single `ITextModel` across split
 *  editors via `MonacoModelRegistry`, monaco's own `model.isDisposed()` guard
 *  stays false after an editor closes, letting the callback reach a disposed
 *  `InstantiationService` and throw "InstantiationService has been disposed".
 *
 *  Lives under `src/` (not under `build/`) so both the Vite plugin and the
 *  vitest unit tests can import it without crossing tsconfig rootDir.
 *--------------------------------------------------------------------------------------------*/

const PATCH_MARKER = '/* monacoUnicodeHighlighterPlugin:patched */'

const TARGET = 'this._updateState = (state) => {'

export function patchUnicodeHighlighterSource(source: string): string {
  if (source.includes(PATCH_MARKER)) return source
  if (!source.includes(TARGET)) return source

  return source.replace(
    TARGET,
    `${TARGET} ${PATCH_MARKER} if (!this._editor.hasModel()) { return; }`,
  )
}
export const UNICODE_HIGHLIGHTER_FILE_SUFFIX = '/unicodeHighlighter/browser/unicodeHighlighter.js'
