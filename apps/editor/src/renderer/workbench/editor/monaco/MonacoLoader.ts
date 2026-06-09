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
import { monacoNavDefaultKeybindingCommandIds } from '../../../actions/gotoLocationActions.js'
import { applyMonacoNls } from './monacoNlsBootstrap.js'
import { registerLogLanguage } from '../../panel/output/monacoLogLanguage.js'

export type { monaco }

let _monaco: typeof monaco | undefined
let _monacoPromise: Promise<typeof monaco> | undefined
let _logger: ILogger = new NullLogger()

type JsonSchemas = NonNullable<monaco.languages.json.DiagnosticsOptions['schemas']>

let _extraSchemas: JsonSchemas = []

// Monaco standalone keys overrideServices by the service-id *string* the
// decorator was created with; IBulkEditService = createDecorator('IWorkspaceEditService'),
// ITextModelService = createDecorator('textModelService').
const BULK_EDIT_SERVICE_ID = 'IWorkspaceEditService'
const TEXT_MODEL_SERVICE_ID = 'textModelService'
let _overrideServices: monaco.editor.IEditorOverrideServices = {}

const BASE_JSON_DIAGNOSTICS: Omit<monaco.languages.json.DiagnosticsOptions, 'schemas'> = {
  validate: true,
  allowComments: true,
  trailingCommas: 'ignore',
  // Surface schema violations (e.g. an unknown command id in keybindings.json)
  // as warnings rather than red errors, and keep JSONC comments quiet.
  schemaValidation: 'warning',
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

  // JSON is the exception: we keep diagnostics ON so settings.json /
  // keybindings.json get schema validation (e.g. unknown command ids surface
  // as warnings). Everything else stays off — TS/JS/CSS/HTML validation is the
  // real memory hog and we don't need it.
  //
  // documentSymbols is forced OFF: monaco 0.52's JSON worker has a special
  // outline branch for files whose path ends with `/user/keybindings.json`
  // (matching VS Code's keybindings) that emits symbols without a `children`
  // field; the jsonMode adapter then mis-detects them as flat SymbolInformation
  // and dereferences a missing `.location`, throwing on open. We don't surface
  // a JSON outline anyway, so disabling it sidesteps the crash.
  const { jsonDefaults } = _monaco.languages.json
  jsonDefaults.setModeConfiguration({
    ...jsonDefaults.modeConfiguration,
    diagnostics: true,
    documentSymbols: false,
  })
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
    // The TS/JS language features are served by the typescript-language-server
    // (real tsserver, cross-file aware) via our LSP client — see the
    // `typescript/` providers + `TypescriptLanguageFeaturesContribution`. Turn
    // off every built-in ts-worker feature we now own so suggestions / hovers /
    // outline don't double up; what's left (formatting, highlights, code
    // actions, inlay hints) the LSP layer doesn't provide yet.
    defaults.setModeConfiguration({
      ...defaults.modeConfiguration,
      diagnostics: false,
      completionItems: false,
      hovers: false,
      signatureHelp: false,
      definitions: false,
      references: false,
      documentSymbols: false,
      rename: false,
    })
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
      // colorize() (markdown code blocks) and any render before the first
      // FileEditor rely on Monaco's global active theme. Align it with the
      // workbench theme the moment Monaco loads — ThemeContribution's startup
      // setTheme runs before Monaco exists, so without this the global theme
      // stays at standalone's default `vs` (light) until a FileEditor is opened.
      const workbenchTheme =
        document.documentElement.dataset.theme === 'light' ? 'output-light' : 'output-dark'
      _monaco.editor.setTheme(workbenchTheme)
      disableLanguageDiagnostics()
      // JSON 是唯一没有 basic-languages Monarch 语法的常见语言：它的着色 tokenizer 只在
      // onLanguage('json')（创建 json model 时）通过 setupMode 注册，而 Markdown 内嵌代码块
      // 走的是 onLanguageEncountered/getOrCreate，二者错配会导致 ```json 块不着色。
      // 主动建一个 json model 触发 onLanguage，把 tokens provider 提前注册上。
      monacoMod.editor.createModel('', 'json').dispose()
      // Drop monaco's built-in Ctrl+Shift+O (quickOutline) default key so it
      // doesn't double-fire alongside our own `workbench.action.gotoSymbol`,
      // which provides the Go to Symbol quick pick. The command itself stays
      // registered (still triggerable via editor.trigger).
      monacoMod.editor.addKeybindingRule({ keybinding: 0, command: '-editor.action.quickOutline' })
      // Same treatment for the goto/peek navigation commands we mirror as
      // project Action2s (gotoLocationActions): drop monaco's built-in default
      // keys so they don't double-fire alongside our global keybinding handler.
      // The commands stay registered (still triggerable via editor.trigger).
      for (const id of monacoNavDefaultKeybindingCommandIds) {
        monacoMod.editor.addKeybindingRule({ keybinding: 0, command: `-${id}` })
      }
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
  /**
   * Register the IBulkEditService override (our cross-file rename writer) used by
   * every `editor.create` call. Must be called before the first editor is
   * created — Monaco's standalone services lock in overrides on first init only.
   */
  setBulkEditService(service: object): void {
    _overrideServices = { ..._overrideServices, [BULK_EDIT_SERVICE_ID]: service }
  },
  /**
   * Register the ITextModelService override (resolves references to files the
   * user hasn't opened by reading them from disk) used by every `editor.create`
   * call. The standalone default rejects with "Model not found" for any
   * unopened resource, breaking the references peek tree. Must be called before
   * the first editor is created — overrides lock in on first init only.
   */
  setTextModelService(service: object): void {
    _overrideServices = { ..._overrideServices, [TEXT_MODEL_SERVICE_ID]: service }
  },
  /** The shared override-services object threaded into all `editor.create` calls. */
  getOverrideServices(): monaco.editor.IEditorOverrideServices {
    return _overrideServices
  },
}

export function setMonacoLoaderLogger(logger: ILogger): void {
  _logger = logger
}
