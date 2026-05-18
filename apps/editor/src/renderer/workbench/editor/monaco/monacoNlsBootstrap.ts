/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoNlsBootstrap — install a translation dictionary onto
 *  `globalThis.__MONACO_NLS__` before monaco-editor is imported. The companion
 *  Vite plugin (`build/plugins/monacoNlsPlugin.ts`) patches monaco's `nls.js`
 *  so that string-keyed `localize(key, fallback, …)` and `localize2(…)` calls
 *  consult this table before falling back to the inline English message.
 *
 *  Why not `_VSCODE_NLS_MESSAGES`? That global is an *index* array consumed by
 *  monaco's AMD/legacy build pipeline. The ESM bundle keeps string keys, so the
 *  array is never indexed — see the bug test in __tests__/monacoNlsBootstrap.test.ts.
 *--------------------------------------------------------------------------------------------*/

import zhCnRaw from '../../../vendor/monaco-nls/zh-cn.json?raw'
import type { SupportedLocale } from '../../../../shared/i18n/availableLocales.js'

type Dict = Readonly<Record<string, string>>

let _zhCn: Dict | null = null
function getZhCn(): Dict {
  if (_zhCn === null) _zhCn = JSON.parse(zhCnRaw) as Dict
  return _zhCn
}

const DICTIONARIES: Partial<Record<SupportedLocale, () => Dict>> = {
  'zh-CN': getZhCn,
}

let _applied = false

export function resetMonacoNlsForTests(): void {
  _applied = false
  const g = globalThis as unknown as { __MONACO_NLS__?: unknown }
  delete g.__MONACO_NLS__
}

export function applyMonacoNls(locale: SupportedLocale): void {
  if (_applied) return
  _applied = true
  const load = DICTIONARIES[locale]
  if (!load) return
  ;(globalThis as unknown as { __MONACO_NLS__: Dict }).__MONACO_NLS__ = load()
}
