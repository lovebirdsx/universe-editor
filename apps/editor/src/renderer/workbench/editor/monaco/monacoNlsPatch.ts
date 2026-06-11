/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoNlsPatch — pure transform applied to monaco-editor's `nls.js`.
 *
 *  monaco ≥0.55 ships a *prebuilt* ESM bundle: `localize(index, fallback, …)` and
 *  `localize2(…)` pass a numeric index and resolve it through `lookupMessage`,
 *  which reads `globalThis._VSCODE_NLS_MESSAGES[index]` and otherwise returns the
 *  inline English `fallback`. The old string-key path is gone, so we hook
 *  `lookupMessage`: before it returns the untranslated English fallback, we look
 *  that English text up in `globalThis.__MONACO_NLS__` (an English→中文 table, see
 *  build-monaco-nls.mjs) and return the translation when present.
 *
 *  Lives under `src/` (not under `build/`) so both the Vite plugin and the vitest
 *  unit tests can import it without crossing tsconfig rootDir.
 *--------------------------------------------------------------------------------------------*/

const PATCH_MARKER = '/* monacoNlsPlugin:patched */'

const HELPER_BLOCK = `
${PATCH_MARKER}
function __monacoNlsLookup__(fallback) {
    if (typeof fallback !== 'string') return undefined;
    const table = globalThis.__MONACO_NLS__;
    if (!table) return undefined;
    const v = table[fallback];
    return typeof v === 'string' ? v : undefined;
}
`

export function patchNlsSource(source: string): string {
  if (source.includes(PATCH_MARKER)) return source

  // Hook lookupMessage(index, fallback): an installed _VSCODE_NLS_MESSAGES entry
  // still wins; only when monaco would fall through to the English fallback do we
  // substitute our English→中文 translation.
  const out = source.replace(
    /function lookupMessage\(([^)]*)\) \{([\s\S]*?)\n\}/,
    (_match, params: string, body: string) =>
      `function lookupMessage(${params}) {\n` +
      `    if (typeof getNLSMessages()?.[index] !== 'string') {\n` +
      `        const __t = __monacoNlsLookup__(fallback);\n` +
      `        if (typeof __t === 'string') return __t;\n` +
      `    }\n` +
      body +
      `\n}`,
  )

  return out + HELPER_BLOCK
}

export const NLS_FILE_SUFFIX = '/monaco-editor/esm/vs/nls.js'
