/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Monaco loader — lazy-loads the monaco-editor package on demand to keep the
 *  initial renderer bundle small. Workers are loaded in parallel via Vite's
 *  `?worker` suffix (separate chunks, instantiated under blob: URLs in dev).
 *--------------------------------------------------------------------------------------------*/

import type * as monaco from 'monaco-editor'
import {
  Emitter,
  NullLogger,
  type Event,
  type IDisposable,
  type ILogger,
} from '@universe-editor/platform'
import { getCurrentLocale } from '../../../../shared/i18n/availableLocales.js'
import { bridgeAllMonacoActions } from './monacoActionsBridge.js'
import { applyMonacoNls } from './monacoNlsBootstrap.js'
import { registerLogLanguage } from '../../panel/output/monacoLogLanguage.js'

export type { monaco }

/** The resource-open request monaco hands a code-editor open handler. */
export interface ICodeEditorOpenInput {
  readonly resource: monaco.Uri
  readonly options?: { readonly selection?: monaco.IRange | monaco.IPosition }
}

/**
 * A handler for `ICodeEditorService.openCodeEditor`. Returning a non-null editor
 * tells monaco the open succeeded *and which editor now shows the target* — the
 * references peek compares this against the source editor to decide whether to
 * stay (same editor) or close the peek and follow to the new file (different
 * editor). Returning null falls through to monaco's default handler.
 */
export type CodeEditorOpenHandler = (
  input: ICodeEditorOpenInput,
  source: monaco.editor.ICodeEditor | null,
  sideBySide?: boolean,
) => Promise<monaco.editor.ICodeEditor | null>

let _monaco: typeof monaco | undefined
let _monacoPromise: Promise<typeof monaco> | undefined
let _logger: ILogger = new NullLogger()

// Fires once monaco's EditorActions have been mirrored into CommandsRegistry by
// bridgeAllMonacoActions(). Those commands register lazily (only when monaco
// loads), so anything that depends on them existing — e.g. re-applying VSCode/
// user keybindings bound to monaco command ids — waits on this signal.
// Subscribing does NOT force a monaco load.
const _onDidBridgeActions = new Emitter<void>()
let _actionsBridged = false

type JsonSchemas = NonNullable<monaco.json.DiagnosticsOptions['schemas']>

let _extraSchemas: JsonSchemas = []

// Monaco standalone keys overrideServices by the service-id *string* the
// decorator was created with; IBulkEditService = createDecorator('IWorkspaceEditService'),
// ITextModelService = createDecorator('textModelService').
const BULK_EDIT_SERVICE_ID = 'IWorkspaceEditService'
const TEXT_MODEL_SERVICE_ID = 'textModelService'
let _overrideServices: monaco.editor.IEditorOverrideServices = {}

const BASE_JSON_DIAGNOSTICS: Omit<monaco.json.DiagnosticsOptions, 'schemas'> = {
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
  _logger.debug(
    `applying ${_extraSchemas.length} JSON schema(s) to Monaco diagnostics: ${_extraSchemas
      .map((s) => `${s.uri} → [${s.fileMatch?.join(', ') ?? ''}]`)
      .join('; ')}`,
  )
  _monaco.json.jsonDefaults.setDiagnosticsOptions({
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
  // documentSymbols stays OFF on the built-in worker: the JSON outline /
  // breadcrumbs / "Go to Symbol in File" flow through the workbench
  // OutlineService, which only enumerates providers registered with
  // ILanguageFeaturesService. JsonLanguageFeaturesContribution registers one
  // such provider (delegating to this same worker via monaco.json.getWorker),
  // so it forwards to Monaco itself — enabling the flag here too would register
  // a second provider and double every symbol in Ctrl+Shift+O.
  const { jsonDefaults } = _monaco.json
  jsonDefaults.setModeConfiguration({
    ...jsonDefaults.modeConfiguration,
    diagnostics: true,
    documentSymbols: false,
  })
  pushJsonDiagnostics()

  const tsDiagnosticsOptions: monaco.typescript.DiagnosticsOptions = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
    onlyVisible: false,
  }
  const { javascriptDefaults, typescriptDefaults } = _monaco.typescript
  for (const defaults of [typescriptDefaults, javascriptDefaults]) {
    defaults.setDiagnosticsOptions(tsDiagnosticsOptions)
    // The TS/JS language features are served by the typescript-language-server
    // (real tsserver, cross-file aware) spawned inside the built-in
    // `extensions/typescript` plugin. Turn off every built-in ts-worker feature
    // we now own so suggestions / hovers / outline don't double up; what's left
    // (formatting, highlights, code actions, inlay hints) the LSP layer doesn't
    // provide yet.
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

  const { cssDefaults, lessDefaults, scssDefaults } = _monaco.css
  for (const defaults of [cssDefaults, lessDefaults, scssDefaults]) {
    defaults.setOptions({ ...defaults.options, validate: false })
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, diagnostics: false })
  }

  const { handlebarDefaults, htmlDefaults, razorDefaults } = _monaco.html
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
      // Lock our override services (FileTextModelService / FileBulkEditService)
      // in *before* anything resolves a standalone service. Monaco's
      // StandaloneServices applies overrides only on first init, and the very
      // first `StandaloneServices.get()` (which setTheme/createModel below would
      // trigger) silently inits with an empty override set — permanently
      // wedging Monaco's defaults. Without this, the references peek tree calls
      // the standalone ITextModelService and throws "Model not found" for files
      // the user hasn't opened. editor.create()'s own initialize(overrides) is
      // then a no-op since init already happened, so we must do it here.
      const { StandaloneServices } =
        await import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js')
      StandaloneServices.initialize(_overrideServices)
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
      // Mirror every monaco-internal EditorAction + core command into our
      // CommandsRegistry / KeybindingsRegistry so the Keyboard Shortcuts
      // editor can list and rebind them. Fire-and-forget — failure here
      // would only mean the shortcuts editor shows fewer entries, the
      // editor itself still works.
      void bridgeAllMonacoActions()
        .then(() => {
          _actionsBridged = true
          _onDidBridgeActions.fire()
        })
        .catch((err) => {
          _logger.error('bridgeAllMonacoActions failed', err)
          // Still flip the flag and fire so waiters
          // (MonacoKeybindingSyncContribution.reload /
          // MonacoDefaultKeybindingOverrideContribution._sync) run against
          // whatever did register instead of hanging forever.
          _actionsBridged = true
          _onDidBridgeActions.fire()
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
  /** Like `get()` but returns undefined instead of throwing when monaco hasn't loaded yet. */
  peek(): typeof monaco | undefined {
    return _monaco
  },
  /** True once monaco's EditorActions have been mirrored into CommandsRegistry. */
  get actionsBridged(): boolean {
    return _actionsBridged
  },
  /** Fires once after the monaco action bridge completes. Does not force a load. */
  onDidBridgeActions: _onDidBridgeActions.event as Event<void>,
  /**
   * Replace the JSON schemas Monaco's JSON language service uses. Bridges that
   * derive schemas from platform registries call this whenever the source data
   * changes. Pass an empty array to clear.
   */
  setJsonSchemas(schemas: JsonSchemas): void {
    _extraSchemas = schemas
    if (!_monaco) {
      _logger.trace(`setJsonSchemas: Monaco not loaded yet, stored ${schemas.length} schema(s)`)
    }
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

  /**
   * Register a cross-file open handler on monaco's resolved ICodeEditorService.
   * Handlers are tried before monaco's standalone default (which can only move
   * the cursor within the already-open model), so this is how "Go to Definition /
   * References" navigates to another file and how the references peek follows the
   * user to the target editor. Resolves after monaco has initialized.
   */
  async registerCodeEditorOpenHandler(handler: CodeEditorOpenHandler): Promise<IDisposable> {
    await loadMonaco()
    const [{ StandaloneServices }, { ICodeEditorService }] = await Promise.all([
      import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'),
      import('monaco-editor/esm/vs/editor/browser/services/codeEditorService.js'),
    ])
    const service = StandaloneServices.get<{
      registerCodeEditorOpenHandler(h: CodeEditorOpenHandler): IDisposable
    }>(ICodeEditorService)
    return service.registerCodeEditorOpenHandler(handler)
  },

  /**
   * Resolve monaco's standalone ICommandService so the workbench can invoke
   * monaco-internal commands that have no public `monaco.*` API — notably the
   * references-peek `openReference` (PeekNavigationContribution drives keyboard
   * Enter through it). Resolves after monaco has initialized.
   */
  async getCommandService(): Promise<{
    executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T>
  }> {
    await loadMonaco()
    const [{ StandaloneServices }, { ICommandService }] = await Promise.all([
      import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'),
      import('monaco-editor/esm/vs/platform/commands/common/commands.js'),
    ])
    return StandaloneServices.get<{
      executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T>
    }>(ICommandService)
  },

  /**
   * Resolve monaco's standalone IListService. We reach `lastFocusedList` to
   * mirror keyboard focus onto the selection inside the references peek so arrow
   * keys preview the focused reference (PeekNavigationContribution); standalone
   * monaco lacks the workbench list keybindings that normally do this. Resolves
   * after monaco has initialized.
   */
  async getListService(): Promise<{
    readonly lastFocusedList:
      | { getFocus(): unknown[]; setSelection(items: unknown[], browserEvent?: unknown): void }
      | undefined
  }> {
    await loadMonaco()
    const [{ StandaloneServices }, { IListService }] = await Promise.all([
      import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'),
      import('monaco-editor/esm/vs/platform/list/browser/listService.js'),
    ])
    return StandaloneServices.get<{
      readonly lastFocusedList:
        | { getFocus(): unknown[]; setSelection(items: unknown[], browserEvent?: unknown): void }
        | undefined
    }>(IListService)
  },
}

export function setMonacoLoaderLogger(logger: ILogger): void {
  _logger = logger
}
