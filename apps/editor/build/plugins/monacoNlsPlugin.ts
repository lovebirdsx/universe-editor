/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoNlsPlugin — Vite plugin that patches monaco-editor's `nls.js` so that
 *  string-keyed `localize(key, fallback, ...)` and `localize2(...)` calls do a
 *  global lookup against `globalThis.__MONACO_NLS__[key]` before falling back to
 *  the inline English message.
 *
 *  The patch logic itself lives in `src/renderer/workbench/editor/monaco/
 *  monacoNlsPatch.ts` so unit tests can exercise it directly.
 *--------------------------------------------------------------------------------------------*/

import type { Plugin } from 'vite'
import {
  NLS_FILE_SUFFIX,
  patchNlsSource,
} from '../../src/renderer/workbench/editor/monaco/monacoNlsPatch'

export function monacoNlsPlugin(): Plugin {
  return {
    name: 'universe-editor:monaco-nls',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.replace(/\\/g, '/')
      if (!normalized.endsWith(NLS_FILE_SUFFIX)) return null
      const patched = patchNlsSource(code)
      if (patched === code) return null
      return { code: patched, map: null }
    },
  }
}
