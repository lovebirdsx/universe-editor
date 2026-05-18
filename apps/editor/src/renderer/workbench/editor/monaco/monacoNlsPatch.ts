/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoNlsPatch — pure transform applied to monaco-editor's `nls.js` so that
 *  string-keyed `localize(key, fallback, ...)` and `localize2(...)` calls do a
 *  global lookup against `globalThis.__MONACO_NLS__[key]` before falling back
 *  to the inline English message.
 *
 *  Lives under `src/` (not under `build/`) so both the Vite plugin and the
 *  vitest unit tests can import it without crossing tsconfig rootDir.
 *--------------------------------------------------------------------------------------------*/

const PATCH_MARKER = '/* monacoNlsPlugin:patched */'

const HELPER_BLOCK = `
${PATCH_MARKER}
function __monacoNlsLookup__(data) {
    let key;
    if (typeof data === 'string') key = data;
    else if (data && typeof data === 'object' && typeof data.key === 'string') key = data.key;
    if (!key) return undefined;
    const table = globalThis.__MONACO_NLS__;
    if (!table) return undefined;
    const v = table[key];
    return typeof v === 'string' ? v : undefined;
}
`

export function patchNlsSource(source: string): string {
  if (source.includes(PATCH_MARKER)) return source
  let out = source

  out = out.replace(
    /export function localize\(([^)]*)\) \{([\s\S]*?)\n\}/,
    (_match, params: string, body: string) =>
      `export function localize(${params}) {\n` +
      `    const __t = __monacoNlsLookup__(data);\n` +
      `    if (typeof __t === 'string') return _format(__t, args);\n` +
      body +
      `\n}`,
  )

  out = out.replace(
    /export function localize2\(([^)]*)\) \{([\s\S]*?)\n\}/,
    (_match, params: string, body: string) =>
      `export function localize2(${params}) {\n` +
      `    const __t = __monacoNlsLookup__(data);\n` +
      `    if (typeof __t === 'string') {\n` +
      `        const value = _format(__t, args);\n` +
      `        return { value, original: _format(originalMessage, args) };\n` +
      `    }\n` +
      body +
      `\n}`,
  )

  return out + HELPER_BLOCK
}

export const NLS_FILE_SUFFIX = '/monaco-editor/esm/vs/nls.js'
