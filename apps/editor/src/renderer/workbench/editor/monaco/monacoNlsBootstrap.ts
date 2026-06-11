/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoNlsBootstrap — install an English→中文 translation table onto
 *  `globalThis.__MONACO_NLS__` before monaco-editor is imported. The companion
 *  Vite plugin (`build/plugins/monacoNlsPlugin.ts`) patches monaco's `nls.js` so
 *  that index-based `localize(index, fallback, …)` / `localize2(…)` calls look the
 *  inline English `fallback` up in this table before returning it untranslated.
 *
 *  The table is keyed by English source text (not message key): monaco's ≥0.55
 *  prebuilt ESM bundle no longer carries string keys — only numeric indices into
 *  `_VSCODE_NLS_MESSAGES` plus the inline English fallback — so the fallback is the
 *  only stable join column. See build-monaco-nls.mjs for how it's produced.
 *--------------------------------------------------------------------------------------------*/

import zhCnRaw from '../../../vendor/monaco-nls/zh-cn.messages.json?raw'
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
