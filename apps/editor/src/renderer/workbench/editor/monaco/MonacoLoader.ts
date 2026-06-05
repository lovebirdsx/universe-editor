/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Monaco loader — lazy-loads the monaco-editor package on demand to keep the
 *  initial renderer bundle small. Workers are loaded in parallel via Vite's
 *  `?worker` suffix (separate chunks, instantiated under blob: URLs in dev).
 *--------------------------------------------------------------------------------------------*/

import type * as monaco from 'monaco-editor'
import { NullLogger, type ILogger } from '@universe-editor/platform'
import { getCurrentLocale } from '../../../../shared/i18n/availableLocales.js'
import { bridgeAllMonacoActions } from './monacoActionsBridge.js'
import { applyMonacoNls } from './monacoNlsBootstrap.js'
import { registerLogLanguage } from '../../panel/output/monacoLogLanguage.js'

export type { monaco }

let _monaco: typeof monaco | undefined
let _monacoPromise: Promise<typeof monaco> | undefined
let _logger: ILogger = new NullLogger()

type JsonSchemas = NonNullable<monaco.languages.json.DiagnosticsOptions['schemas']>

let _extraSchemas: JsonSchemas = []

const BASE_JSON_DIAGNOSTICS: Omit<monaco.languages.json.DiagnosticsOptions, 'schemas'> = {
  validate: false,
  allowComments: true,
  trailingCommas: 'ignore',
  schemaValidation: 'ignore',
  schemaRequest: 'ignore',
  comments: 'ignore',
}

function pushJsonDiagnostics(): void {
  if (!_monaco) return
  _monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    ...BASE_JSON_DIAGNOSTICS,
    schemas: _extraSchemas,
  })
}

function disableLanguageDiagnostics(): void {
  if (!_monaco) return

  const { jsonDefaults } = _monaco.languages.json
  jsonDefaults.setModeConfiguration({ ...jsonDefaults.modeConfiguration, diagnostics: false })
  pushJsonDiagnostics()

  const tsDiagnosticsOptions: monaco.languages.typescript.DiagnosticsOptions = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
    onlyVisible: false,
  }
  const { javascriptDefaults, typescriptDefaults } = _monaco.languages.typescript
  for (const defaults of [typescriptDefaults, javascriptDefaults]) {
    defaults.setDiagnosticsOptions(tsDiagnosticsOptions)
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, diagnostics: false })
  }

  const { cssDefaults, lessDefaults, scssDefaults } = _monaco.languages.css
  for (const defaults of [cssDefaults, lessDefaults, scssDefaults]) {
    defaults.setOptions({ ...defaults.options, validate: false })
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, diagnostics: false })
  }

  const { handlebarDefaults, htmlDefaults, razorDefaults } = _monaco.languages.html
  for (const defaults of [htmlDefaults, handlebarDefaults, razorDefaults]) {
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, diagnostics: false })
  }
}

async function loadMonaco(): Promise<typeof monaco> {
  if (_monaco) return _monaco
  if (!_monacoPromise) {
    _monacoPromise = (async () => {
      applyMonacoNls(getCurrentLocale())
      const [monacoMod, EditorWorker, JsonWorker, TsWorker, CssWorker, HtmlWorker] =
        await Promise.all([
          import('monaco-editor'),
          import('monaco-editor/esm/vs/editor/editor.worker?worker'),
          import('monaco-editor/esm/vs/language/json/json.worker?worker'),
          import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
          import('monaco-editor/esm/vs/language/css/css.worker?worker'),
          import('monaco-editor/esm/vs/language/html/html.worker?worker'),
        ])
      ;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
        getWorker(_workerId, label) {
          if (label === 'json') return new JsonWorker.default()
          if (label === 'typescript' || label === 'javascript') return new TsWorker.default()
          if (label === 'css' || label === 'scss' || label === 'less')
            return new CssWorker.default()
          if (label === 'html' || label === 'handlebars' || label === 'razor') {
            return new HtmlWorker.default()
          }
          return new EditorWorker.default()
        },
      }
      _monaco = monacoMod
      registerLogLanguage(_monaco)
      disableLanguageDiagnostics()
      // Mirror every monaco-internal EditorAction + core command into our
      // CommandsRegistry / KeybindingsRegistry so the Keyboard Shortcuts
      // editor can list and rebind them. Fire-and-forget — failure here
      // would only mean the shortcuts editor shows fewer entries, the
      // editor itself still works.
      void bridgeAllMonacoActions().catch((err) => {
        _logger.error('bridgeAllMonacoActions failed', err)
      })
      return monacoMod
    })()
  }
  return _monacoPromise
}

export const MonacoLoader = {
  ensureInitialized(): Promise<typeof monaco> {
    return loadMonaco()
  },
  get(): typeof monaco {
    if (!_monaco) {
      throw new Error('[MonacoLoader] not initialized; call ensureInitialized() first')
    }
    return _monaco
  },
  /**
   * Replace the JSON schemas Monaco's JSON language service uses. Bridges that
   * derive schemas from platform registries call this whenever the source data
   * changes. Pass an empty array to clear.
   */
  setJsonSchemas(schemas: JsonSchemas): void {
    _extraSchemas = schemas
    pushJsonDiagnostics()
  },
}

export function setMonacoLoaderLogger(logger: ILogger): void {
  _logger = logger
}
