/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoUnicodeHighlighterPatch — pure transform applied to monaco-editor's
 *  `unicodeHighlighter.js`. It wraps `UnicodeHighlighter._updateState` so the
 *  async highlight callback can never throw during teardown. Two independent
 *  races reach a disposed service:
 *
 *    1. The editor lost its model (editor was disposed). Because we share a
 *       single `ITextModel` across split editors via `MonacoModelRegistry`,
 *       monaco's own `model.isDisposed()` guard stays false after an editor
 *       closes — so the worker callback still fires. `hasModel()` bails first.
 *    2. The global standalone `InstantiationService` was disposed (window reload
 *       / monaco teardown) while this editor is still mounted, so `hasModel()`
 *       is still true. `_bannerController.show` then builds an ActionBar / hover
 *       delegate off the dead service and throws "InstantiationService has been
 *       disposed". The try/catch swallows it.
 *
 *  We replace `this._updateState` right before the `BannerController` is created,
 *  so the wrapped reference is exactly the one every later `DocumentUnicode`/
 *  `ViewportUnicodeHighlighter` captures and invokes from its worker callback.
 *
 *  Lives under `src/` (not under `build/`) so both the Vite plugin and the
 *  vitest unit tests can import it without crossing tsconfig rootDir.
 *--------------------------------------------------------------------------------------------*/

const PATCH_MARKER = '/* monacoUnicodeHighlighterPlugin:patched */'

// Stable single-line anchor (monaco is pinned at 0.52.x). The wrapper is spliced
// in just before it, where `this._updateState` already holds the original.
const ANCHOR =
  'this._bannerController = this._register(instantiationService.createInstance(BannerController, _editor));'

const WRAPPER =
  'const __ueOrigUpdateState = this._updateState; ' +
  'this._updateState = (state) => { ' +
  'if (!this._editor.hasModel()) { return; } ' +
  'try { __ueOrigUpdateState(state); } catch (e) { } ' +
  '}; '

export function patchUnicodeHighlighterSource(source: string): string {
  if (source.includes(PATCH_MARKER)) return source
  if (!source.includes(ANCHOR)) return source

  return source.replace(ANCHOR, `${PATCH_MARKER} ${WRAPPER}${ANCHOR}`)
}
export const UNICODE_HIGHLIGHTER_FILE_SUFFIX = '/unicodeHighlighter/browser/unicodeHighlighter.js'
