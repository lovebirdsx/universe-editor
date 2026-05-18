/*---------------------------------------------------------------------------------------------
 *  Verify the Monaco NLS bootstrap end-to-end:
 *   1. `applyMonacoNls('zh-CN')` populates `globalThis.__MONACO_NLS__`
 *   2. The Vite-plugin patch applied to monaco's `nls.js` honours that table for
 *      both `localize('key', fallback)` and `localize2(...)` calls, which is the
 *      whole point — the unpatched ESM build ignores them entirely.
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
  localize: (data: string | { key: string }, message: string, ...args: unknown[]) => string
  localize2: (
    data: string | { key: string },
    originalMessage: string,
    ...args: unknown[]
  ) => { value: string; original: string }
}

function loadPatchedNls(): PatchedNls {
  const nlsPath = path.resolve(__dirname, '../../../../../node_modules/monaco-editor/esm/vs/nls.js')
  const original = fs.readFileSync(nlsPath, 'utf8')
  const patched = patchNlsSource(original)
  // Strip ESM syntax so the source can run inside `new Function`. Stub the two
  // helpers monaco imports from `./nls.messages.js` — neither matters here:
  // `getNLSLanguage()` only feeds the pseudo-locale check at module load, and
  // `getNLSMessages()` is only consulted when a *numeric* index is passed (the
  // AMD path, which our patch short-circuits in favour of the global table).
  const stripped = patched
    .replace(/^import [^\n]*\n/gm, '')
    .replace(/^export \{[^}]*\}[^\n]*\n/gm, '')
    .replace(/export function/g, 'function')
  const factory = new Function(
    'globalThis',
    `const getNLSLanguage = () => 'en'; const getNLSMessages = () => undefined;\n${stripped}\nreturn { localize, localize2 };`,
  ) as (g: typeof globalThis) => PatchedNls
  return factory(globalThis)
}

describe('monacoNlsBootstrap — globalThis side effects', () => {
  beforeEach(() => {
    clearGlobals()
    resetMonacoNlsForTests()
  })
  afterEach(clearGlobals)

  it('populates globalThis.__MONACO_NLS__ with the zh-CN dictionary', () => {
    applyMonacoNls('zh-CN')
    const table = (globalThis as NlsGlobals).__MONACO_NLS__
    expect(table).toBeDefined()
    expect(Object.keys(table ?? {}).length).toBeGreaterThan(1000)
    expect(table?.['caseDescription']).toBe('区分大小写')
    expect(table?.['wordsDescription']).toBe('全字匹配')
    expect(table?.['regexDescription']).toBe('使用正则表达式')
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

describe('monaco nls patch — string-key localize now consults the table', () => {
  let nls: PatchedNls

  beforeEach(() => {
    clearGlobals()
    resetMonacoNlsForTests()
    nls = loadPatchedNls()
  })
  afterEach(clearGlobals)

  it('string-key localize returns the translation when __MONACO_NLS__ has it', () => {
    applyMonacoNls('zh-CN')
    expect(nls.localize('caseDescription', 'Match Case')).toBe('区分大小写')
    expect(nls.localize('wordsDescription', 'Match Whole Word')).toBe('全字匹配')
    expect(nls.localize('regexDescription', 'Use Regular Expression')).toBe('使用正则表达式')
  })

  it('object-key form { key, comment } also consults the table', () => {
    applyMonacoNls('zh-CN')
    expect(
      nls.localize(
        { key: 'caseDescription', comment: ['Match Case'] } as { key: string },
        'Match Case',
      ),
    ).toBe('区分大小写')
  })

  it('falls back to the inline English message when the key is missing', () => {
    applyMonacoNls('zh-CN')
    expect(nls.localize('nonexistent_key_xyzzy', 'Original Text')).toBe('Original Text')
  })

  it('falls back to the inline English message when no table is installed', () => {
    expect(nls.localize('caseDescription', 'Match Case')).toBe('Match Case')
  })

  it('localize2 returns { value: <translated>, original: <english> }', () => {
    applyMonacoNls('zh-CN')
    const r = nls.localize2('caseDescription', 'Match Case')
    expect(r.value).toBe('区分大小写')
    expect(r.original).toBe('Match Case')
  })

  it('format args interpolate correctly after translation', () => {
    ;(globalThis as NlsGlobals).__MONACO_NLS__ = { greet: '你好，{0}！' }
    expect(nls.localize('greet', 'Hello, {0}!', 'World')).toBe('你好，World！')
  })
})
