/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoNlsBootstrap — Monaco 0.52+ reads its localized strings from
 *  globalThis._VSCODE_NLS_MESSAGES (an index array) and _VSCODE_NLS_LANGUAGE.
 *  The translation files shipped under monaco-editor/dev/vs/nls.messages.<lang>.js
 *  are AMD-wrapped, but their factory body simply assigns the array onto
 *  globalThis. We strip the AMD wrapper at runtime via a temporary `define`
 *  shim so the assignment runs and the editor picks the locale up the first
 *  time it loads.
 *--------------------------------------------------------------------------------------------*/

import zhCnSource from 'monaco-editor/dev/vs/nls.messages.zh-cn.js?raw'
import type { SupportedLocale } from '../../../../shared/i18n/availableLocales.js'

interface IMonacoNlsEntry {
  readonly language: string
  readonly source: string
}

const SOURCES: Partial<Record<SupportedLocale, IMonacoNlsEntry>> = {
  'zh-CN': { language: 'zh-cn', source: zhCnSource },
}

let _applied = false

export function applyMonacoNls(locale: SupportedLocale): void {
  if (_applied) return
  _applied = true
  const entry = SOURCES[locale]
  if (!entry) return

  const g = globalThis as unknown as {
    define?: unknown
    _VSCODE_NLS_LANGUAGE?: string
  }
  const prevDefine = g.define
  g.define = (_deps: unknown, factory: () => void) => {
    factory()
  }
  try {
    new Function(entry.source)()
  } finally {
    if (prevDefine === undefined) delete g.define
    else g.define = prevDefine
  }
  g._VSCODE_NLS_LANGUAGE = entry.language
}
