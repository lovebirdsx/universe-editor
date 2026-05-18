/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoNlsPlugin — Vite plugin that patches monaco-editor's `nls.js` so that
 *  string-keyed `localize(key, fallback, ...)` and `localize2(...)` calls do a
 *  global lookup against `globalThis.__MONACO_NLS__[key]` before falling back to
 *  the inline English message.
 *
 *  Background: monaco 0.52 ESM compiles every NLS call into
 *    localize('caseDescription', 'Match Case')
 *  whereas the upstream `_VSCODE_NLS_MESSAGES` index-array shim only services
 *  the numeric-index form `localize(27, null)` produced by the AMD/legacy build
 *  pipeline. The ESM path therefore never consults the global table. This
 *  plugin rewrites the body of `localize` and `localize2` to consult our table
 *  by key, leaving the public signatures intact.
 *--------------------------------------------------------------------------------------------*/
const NLS_FILE_SUFFIX = '/monaco-editor/esm/vs/nls.js';
const PATCH_MARKER = '/* monacoNlsPlugin:patched */';
function patchNlsSource(source) {
    if (source.includes(PATCH_MARKER))
        return source;
    const helperBlock = `
${PATCH_MARKER}
function __monacoNlsLookup__(data) {
    let key;
    if (typeof data === 'string') key = data;
    else if (data && typeof data === 'object' && typeof data.key === 'string') key = data.key;
    if (!key) return undefined;
    const table = /** @type {any} */ (globalThis).__MONACO_NLS__;
    if (!table) return undefined;
    const v = table[key];
    return typeof v === 'string' ? v : undefined;
}
`;
    let out = source;
    out = out.replace(/export function localize\(([^)]*)\) \{([\s\S]*?)\n\}/, (_match, params, body) => {
        return (`export function localize(${params}) {\n` +
            `    const __t = __monacoNlsLookup__(data);\n` +
            `    if (typeof __t === 'string') return _format(__t, args);\n` +
            body +
            `\n}`);
    });
    out = out.replace(/export function localize2\(([^)]*)\) \{([\s\S]*?)\n\}/, (_match, params, body) => {
        return (`export function localize2(${params}) {\n` +
            `    const __t = __monacoNlsLookup__(data);\n` +
            `    if (typeof __t === 'string') {\n` +
            `        const value = _format(__t, args);\n` +
            `        return { value, original: _format(originalMessage, args) };\n` +
            `    }\n` +
            body +
            `\n}`);
    });
    return out + helperBlock;
}
export function monacoNlsPlugin() {
    return {
        name: 'universe-editor:monaco-nls',
        enforce: 'pre',
        transform(code, id) {
            const normalized = id.replace(/\\/g, '/');
            if (!normalized.endsWith(NLS_FILE_SUFFIX))
                return null;
            const patched = patchNlsSource(code);
            if (patched === code)
                return null;
            return { code: patched, map: null };
        },
    };
}
export { patchNlsSource };
