/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Monaco loader — lazy-loads the monaco-editor package on demand to keep the
 *  initial renderer bundle small. Workers are loaded in parallel via Vite's
 *  `?worker` suffix (separate chunks, instantiated under blob: URLs in dev).
 *--------------------------------------------------------------------------------------------*/

import type * as monaco from 'monaco-editor'
import { getCurrentLocale } from '../../../../shared/i18n/availableLocales.js'
import { bridgeAllMonacoActions } from './monacoActionsBridge.js'
import { applyMonacoNls } from './monacoNlsBootstrap.js'

export type { monaco }

let _monaco: typeof monaco | undefined
let _monacoPromise: Promise<typeof monaco> | undefined

type JsonSchemas = NonNullable<monaco.languages.json.DiagnosticsOptions['schemas']>

let _extraSchemas: JsonSchemas = []

const BASE_JSON_DIAGNOSTICS: Omit<monaco.languages.json.DiagnosticsOptions, 'schemas'> = {
  validate: true,
  allowComments: true,
  trailingCommas: 'warning',
  schemaValidation: 'error',
  schemaRequest: 'warning',
}

function pushJsonDiagnostics(): void {
  if (!_monaco) return
  _monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    ...BASE_JSON_DIAGNOSTICS,
    schemas: _extraSchemas,
  })
}

async function loadMonaco(): Promise<typeof monaco> {
  if (_monaco) return _monaco
  if (!_monacoPromise) {
    _monacoPromise = (async () => {
      applyMonacoNls(getCurrentLocale())
      const [monacoMod, EditorWorker, JsonWorker] = await Promise.all([
        import('monaco-editor'),
        import('monaco-editor/esm/vs/editor/editor.worker?worker'),
        import('monaco-editor/esm/vs/language/json/json.worker?worker'),
      ])
      ;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
        getWorker(_workerId, label) {
          if (label === 'json') return new JsonWorker.default()
          return new EditorWorker.default()
        },
      }
      _monaco = monacoMod
      pushJsonDiagnostics()
      // Mirror every monaco-internal EditorAction + core command into our
      // CommandsRegistry / KeybindingsRegistry so the Keyboard Shortcuts
      // editor can list and rebind them. Fire-and-forget — failure here
      // would only mean the shortcuts editor shows fewer entries, the
      // editor itself still works.
      void bridgeAllMonacoActions().catch((err) => {
        console.error('[MonacoLoader] bridgeAllMonacoActions failed', err)
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
