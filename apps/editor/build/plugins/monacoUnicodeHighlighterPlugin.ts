/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoUnicodeHighlighterPlugin — Vite plugin that patches monaco-editor's
 *  `unicodeHighlighter.js` so the async highlight callback bails out after the
 *  editor is disposed (see monacoUnicodeHighlighterPatch.ts for the why).
 *
 *  The patch logic itself lives in `src/renderer/workbench/editor/monaco/
 *  monacoUnicodeHighlighterPatch.ts` so unit tests can exercise it directly.
 *--------------------------------------------------------------------------------------------*/

import type { Plugin } from 'vite'
import {
  UNICODE_HIGHLIGHTER_FILE_SUFFIX,
  patchUnicodeHighlighterSource,
} from '../../src/renderer/workbench/editor/monaco/monacoUnicodeHighlighterPatch'

export function monacoUnicodeHighlighterPlugin(): Plugin {
  return {
    name: 'universe-editor:monaco-unicode-highlighter',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.replace(/\\/g, '/')
      if (!normalized.endsWith(UNICODE_HIGHLIGHTER_FILE_SUFFIX)) return null
      const patched = patchUnicodeHighlighterSource(code)
      if (patched === code) return null
      return { code: patched, map: null }
    },
  }
}
