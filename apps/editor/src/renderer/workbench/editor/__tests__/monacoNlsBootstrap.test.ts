/*---------------------------------------------------------------------------------------------
 *  Verify the Monaco NLS bootstrap end-to-end for the ≥0.55 index-based ESM build:
 *   1. `applyMonacoNls('zh-CN')` populates `globalThis.__MONACO_NLS__` with an
 *      English→中文 table.
 *   2. The Vite-plugin patch applied to monaco's `nls.js` makes index-based
 *      `localize(index, fallback)` / `localize2(…)` substitute that table's
 *      translation for the inline English fallback — the whole point, since the
 *      unpatched bundle just returns the English fallback when no
 *      `_VSCODE_NLS_MESSAGES` entry exists.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMonacoNls, resetMonacoNlsForTests } from '../monaco/monacoNlsBootstrap.js'
import { patchNlsSource } from '../monaco/monacoNlsPatch.js'

type NlsGlobals = { __MONACO_NLS__?: Record<string, string> }

function clearGlobals(): void {
  const g = globalThis as NlsGlobals
  delete g.__MONACO_NLS__
}

interface PatchedNls {
  localize: (index: number, message: string, ...args: unknown[]) => string
  localize2: (
    index: number,
    originalMessage: string,
    ...args: unknown[]
  ) => { value: string; original: string }
}

// Loads the real monaco nls.js, applies our patch, and evaluates it with a stub
// `getNLSMessages` so the test controls whether an index-based message exists.
function loadPatchedNls(nlsMessages: (string | undefined)[] | undefined = undefined): PatchedNls {
  const nlsPath = path.resolve(__dirname, '../../../../../node_modules/monaco-editor/esm/vs/nls.js')
  const original = fs.readFileSync(nlsPath, 'utf8')
  const patched = patchNlsSource(original)
  const stripped = patched
    .replace(/^import [^\n]*\n/gm, '')
    .replace(/^export \{[^}]*\}[^\n]*\n/gm, '')
    .replace(/export function/g, 'function')
  const factory = new Function(
    'globalThis',
    'nlsMessages',
    `const getNLSLanguage = () => 'en'; const getNLSMessages = () => nlsMessages;\n${stripped}\nreturn { localize, localize2 };`,
  ) as (g: typeof globalThis, m: (string | undefined)[] | undefined) => PatchedNls
  return factory(globalThis, nlsMessages)
}

describe('monacoNlsBootstrap — globalThis side effects', () => {
  beforeEach(() => {
    clearGlobals()
    resetMonacoNlsForTests()
  })
  afterEach(clearGlobals)

  it('populates globalThis.__MONACO_NLS__ with the English→中文 table', () => {
    applyMonacoNls('zh-CN')
    const table = (globalThis as NlsGlobals).__MONACO_NLS__
    expect(table).toBeDefined()
    expect(Object.keys(table ?? {}).length).toBeGreaterThan(1000)
    expect(table?.['Match Case']).toBe('区分大小写')
    expect(table?.['Match Whole Word']).toBe('全字匹配')
    expect(table?.['Use Regular Expression']).toBe('使用正则表达式')
  })

  it('leaves the global untouched when locale=en-US', () => {
    applyMonacoNls('en-US')
    expect((globalThis as NlsGlobals).__MONACO_NLS__).toBeUndefined()
  })

  it('is idempotent — calling apply twice keeps the first install', () => {
    applyMonacoNls('zh-CN')
    applyMonacoNls('en-US')
    expect((globalThis as NlsGlobals).__MONACO_NLS__).toBeDefined()
  })
})

describe('monaco nls patch — index-based localize consults the English→中文 table', () => {
  beforeEach(() => {
    clearGlobals()
    resetMonacoNlsForTests()
  })
  afterEach(clearGlobals)

  it('translates the English fallback when __MONACO_NLS__ has it', () => {
    const nls = loadPatchedNls()
    applyMonacoNls('zh-CN')
    expect(nls.localize(0, 'Match Case')).toBe('区分大小写')
    expect(nls.localize(1, 'Match Whole Word')).toBe('全字匹配')
    expect(nls.localize(2, 'Use Regular Expression')).toBe('使用正则表达式')
  })

  it('an installed _VSCODE_NLS_MESSAGES entry still wins over the fallback table', () => {
    const nls = loadPatchedNls(['原生索引消息'])
    applyMonacoNls('zh-CN')
    expect(nls.localize(0, 'Match Case')).toBe('原生索引消息')
  })

  it('falls back to the inline English message when the fallback is not in the table', () => {
    const nls = loadPatchedNls()
    applyMonacoNls('zh-CN')
    expect(nls.localize(0, 'Original Text Not In Any Dictionary')).toBe(
      'Original Text Not In Any Dictionary',
    )
  })

  it('falls back to the inline English message when no table is installed', () => {
    const nls = loadPatchedNls()
    expect(nls.localize(0, 'Match Case')).toBe('Match Case')
  })

  it('localize2 returns { value: <translated>, original: <english> }', () => {
    const nls = loadPatchedNls()
    applyMonacoNls('zh-CN')
    const r = nls.localize2(0, 'Match Case')
    expect(r.value).toBe('区分大小写')
    expect(r.original).toBe('Match Case')
  })

  it('format args interpolate correctly after translation', () => {
    const nls = loadPatchedNls()
    ;(globalThis as NlsGlobals).__MONACO_NLS__ = { 'Hello, {0}!': '你好，{0}！' }
    expect(nls.localize(0, 'Hello, {0}!', 'World')).toBe('你好，World！')
  })
})
