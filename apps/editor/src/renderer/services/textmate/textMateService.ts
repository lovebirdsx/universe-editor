/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's TextMateTokenizationFeature (workbench/services/textMate).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  IFileService,
  ILoggerService,
  NullLogger,
  URI,
  createDecorator,
  markAsSingleton,
  type Event,
  type IDisposable,
  type ILogger,
} from '@universe-editor/platform'
import type {
  IGrammarContribution,
  ILanguageContribution,
} from '@universe-editor/extensions-common'
import type {
  ITokenizationSupport,
  LazyTokenizationSupport as LazyTokenizationSupportClass,
} from 'monaco-editor/esm/vs/editor/common/languages.js'
import type { IRawTheme } from 'vscode-textmate'
import type { IThemeRegistrationContext } from '../extensions/ExtensionPointTranslator.js'
import { languageRegistry, type ILanguageDefinition } from '../languages/LanguageRegistry.js'
import {
  parseLanguageConfiguration,
  type ILanguageConfigurationMapping,
} from '../languages/languageConfiguration.js'
import { GrammarRegistry, type IGrammarDefinition } from './grammarRegistry.js'
import { toMonacoLanguageId } from './languageIdMapping.js'
import { getOnigLib } from './onigurumaLoader.js'
import { TMGrammarFactory } from './tmGrammarFactory.js'
import { MAX_TOKENIZATION_LINE_LENGTH } from './textMateTokenizationSupport.js'

export interface ITextMateService {
  readonly _serviceBrand: undefined

  /** Batch-register `contributes.grammars` entries (translator callback). */
  registerGrammars(
    grammars: readonly IGrammarContribution[],
    context: IThemeRegistrationContext,
  ): IDisposable

  /** Batch-register `contributes.languages` entries (translator callback). */
  registerLanguages(
    languages: readonly ILanguageContribution[],
    context: IThemeRegistrationContext,
  ): IDisposable

  readonly grammarRegistry: GrammarRegistry
  readonly onDidChangeGrammars: Event<void>

  /**
   * Wire into monaco's TokenizationRegistry. Must run after the monaco
   * package finished initializing (standalone services lock on first use).
   */
  initialize(monaco: {
    languages: {
      getEncodedLanguageId(languageId: string): number
      getLanguages(): readonly { id: string }[]
      register(language: IMonacoLanguagePoint): void
      setLanguageConfiguration(
        languageId: string,
        configuration: ILanguageConfigurationMapping,
      ): void
    }
    editor: {
      getModels(): readonly { getLanguageId(): string }[]
      onDidCreateModel(listener: (model: { getLanguageId(): string }) => void): IDisposable
      onDidChangeModelLanguage(
        listener: (e: { model: { getLanguageId(): string } }) => void,
      ): IDisposable
    }
  }): Promise<void>

  /**
   * Forward a color theme's token rules into the textmate registry so newly
   * produced tokens carry colorMap-indexed metadata. The `.mtkN` classifier
   * stylesheet and `TokenizationRegistry.setColorMap` are owned exclusively by
   * monaco's StandaloneThemeService: monacoThemeBridge passes the same
   * colorMap as `encodedTokensColors` through defineTheme, which makes
   * monaco's TokenTheme mirror it index-for-index (single source of truth —
   * a second stylesheet here would race it by DOM order).
   * Safe before initialize(): the theme is replayed then.
   */
  setTheme(theme: IRawTheme, colorMap: string[]): void
}

export const ITextMateService = createDecorator<ITextMateService>('textMateService')

/** A language registration handed to `monaco.languages.register`. */
export interface IMonacoLanguagePoint {
  readonly id: string
  readonly aliases?: string[]
  readonly extensions?: string[]
  readonly filenames?: string[]
  readonly filenamePatterns?: string[]
  readonly mimetypes?: string[]
}

/** monaco deep-import surface resolved during initialize(). */
interface IMonacoTokenizationBindings {
  readonly TokenizationRegistry: {
    registerFactory(languageId: string, factory: LazyTokenizationSupportClass): { dispose(): void }
    getOrCreate(languageId: string): Promise<ITokenizationSupport | null>
    handleChange(languageIds: string[]): void
  }
  readonly LazyTokenizationSupport: new (
    createSupport: () => Promise<(ITokenizationSupport & IDisposable) | null>,
  ) => LazyTokenizationSupportClass
}

export class TextMateService extends Disposable implements ITextMateService {
  declare readonly _serviceBrand: undefined

  readonly grammarRegistry = new GrammarRegistry()
  readonly onDidChangeGrammars = this.grammarRegistry.onDidChangeGrammars

  private readonly _logger: ILogger
  private _monaco: IMonacoTokenizationBindings | undefined
  private _encodeLanguageId: ((languageId: string) => number) | undefined
  private _languages:
    | {
        register(language: IMonacoLanguagePoint): void
        setLanguageConfiguration(
          languageId: string,
          configuration: ILanguageConfigurationMapping,
        ): void
      }
    | undefined
  private _knownLanguages: Set<string> | undefined
  private _getLiveLanguages: (() => Set<string>) | undefined
  private _registrations: DisposableStore | undefined
  private _grammarFactory: TMGrammarFactory | undefined
  private _pendingTheme: { theme: IRawTheme; colorMap: string[] } | undefined
  /** monaco language ids owned by the current factory registrations. */
  private _registeredLanguages: ReadonlySet<string> = new Set()

  constructor(
    @IFileService private readonly _fileService: IFileService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'textmate', name: 'TextMate' }) ?? new NullLogger()
  }

  registerGrammars(
    grammars: readonly IGrammarContribution[],
    context: IThemeRegistrationContext,
  ): IDisposable {
    const definitions: IGrammarDefinition[] = grammars.map((grammar) => ({
      ...grammar,
      location: URI.joinPath(context.extensionLocation, grammar.path),
      sourceExtensionId: context.extensionId,
    }))
    return this.grammarRegistry.registerGrammars(definitions)
  }

  registerLanguages(
    languages: readonly ILanguageContribution[],
    context: IThemeRegistrationContext,
  ): IDisposable {
    const definitions: ILanguageDefinition[] = languages.map((language) => ({
      ...language,
      extensionLocation: context.extensionLocation,
      sourceExtensionId: context.extensionId,
    }))
    return languageRegistry.registerLanguages(definitions)
  }

  async initialize(monaco: {
    languages: {
      getEncodedLanguageId(languageId: string): number
      getLanguages(): readonly { id: string }[]
      register(language: IMonacoLanguagePoint): void
      setLanguageConfiguration(
        languageId: string,
        configuration: ILanguageConfigurationMapping,
      ): void
    }
    editor: {
      getModels(): readonly { getLanguageId(): string }[]
      onDidCreateModel(listener: (model: { getLanguageId(): string }) => void): IDisposable
      onDidChangeModelLanguage(
        listener: (e: { model: { getLanguageId(): string } }) => void,
      ): IDisposable
    }
  }): Promise<void> {
    if (this._monaco !== undefined) {
      return
    }
    const languages = await import('monaco-editor/esm/vs/editor/common/languages.js')
    this._monaco = {
      TokenizationRegistry: languages.TokenizationRegistry,
      LazyTokenizationSupport: languages.LazyTokenizationSupport,
    }
    this._encodeLanguageId = (languageId) => monaco.languages.getEncodedLanguageId(languageId)
    this._languages = monaco.languages
    // Monaco's createModel falls back to plaintext for language ids its own
    // registry doesn't know (LanguageService._createAndGetLanguageIdentifier),
    // which would silently un-tokenize grammar-only languages like toml. The
    // selection re-evaluates on language registration, so models already open
    // switch over once we register the id here.
    this._knownLanguages = new Set(monaco.languages.getLanguages().map((l) => l.id))
    this._register(this.grammarRegistry.onDidChangeGrammars(() => this._rebuildRegistrations()))
    this._register(
      languageRegistry.onDidChangeLanguages(() => this._rebuildLanguageRegistrations()),
    )
    this._getLiveLanguages = () =>
      new Set(monaco.editor.getModels().map((model) => model.getLanguageId()))
    // Models resolve tokenization exactly once per language via monaco's
    // requestRichLanguageFeatures (deduped by language id). When that one shot
    // happened before our factory registration — and the rebuild found no live
    // model to warm up — a model created afterwards would only observe the
    // registry (`get()` + change event) and stay untokenized forever. Warm up
    // at model birth / language switch to cover that direction of the race;
    // getOrCreate is idempotent once resolved.
    this._register(
      monaco.editor.onDidCreateModel((model) => this._warmUpLanguage(model.getLanguageId())),
    )
    this._register(
      monaco.editor.onDidChangeModelLanguage((e) => this._warmUpLanguage(e.model.getLanguageId())),
    )
    this._rebuildRegistrations()
    this._rebuildLanguageRegistrations()
    if (this._pendingTheme !== undefined) {
      this.setTheme(this._pendingTheme.theme, this._pendingTheme.colorMap)
      this._pendingTheme = undefined
    }
  }

  /**
   * Dispose every factory registration and re-register from the current
   * grammar set (VSCode `_handleGrammarsExtPoint`). Disposing a factory
   * unregisters its resolved support and fires the registry change that makes
   * open models re-tokenize with the new factory.
   *
   * The TMGrammarFactory itself is created once and reused (like VSCode's
   * `_getOrCreateGrammarFactory`): its vscode-textmate Registry holds the
   * applied theme and the grammar cache, and `loadGrammar` resolves against
   * the live GrammarRegistry, so newly registered grammars load without
   * rebuilding it.
   */
  private _rebuildRegistrations(): void {
    const monaco = this._monaco
    if (monaco === undefined || this._encodeLanguageId === undefined) {
      return
    }
    this._registrations?.dispose()
    this._registrations = undefined
    this._grammarFactory ??= this._register(
      new TMGrammarFactory(
        {
          logger: this._logger,
          readFile: (location) => this._fileService.readFileText(location),
        },
        this.grammarRegistry,
        getOnigLib(),
        this._encodeLanguageId,
      ),
    )

    const registrations = new DisposableStore()
    const seenLanguages = new Set<string>()
    for (const definition of this.grammarRegistry.getDefinitions()) {
      if (definition.language === undefined) {
        continue
      }
      const monacoLanguageId = toMonacoLanguageId(definition.language)
      if (seenLanguages.has(monacoLanguageId)) {
        // Several manifest languages can collapse onto one monaco id (json +
        // jsonc + jsonl → json): the first grammar in extension order wins.
        this._logger.trace(
          `grammar for ${definition.language} skipped: monaco language ${monacoLanguageId} already bound`,
        )
        continue
      }
      seenLanguages.add(monacoLanguageId)
      this._registerMonacoLanguagePoint({ id: monacoLanguageId })
      const lazySupport = new monaco.LazyTokenizationSupport(() =>
        this._createTokenizationSupport(monacoLanguageId, definition),
      )
      registrations.add(lazySupport)
      registrations.add(monaco.TokenizationRegistry.registerFactory(monacoLanguageId, lazySupport))
    }
    this._registrations = this._register(registrations)
    this._registeredLanguages = seenLanguages
    this._logger.info(
      `registered ${seenLanguages.size} TextMate grammar factories: ${[...seenLanguages].join(', ')}`,
    )

    // VSCode _handleGrammarsExtPoint warms up `createdModes`: a fresh factory
    // only resolves when someone calls getOrCreate. TextModel does that once at
    // creation time, so a model opened before this rebuild would stay
    // untokenized forever — including the race where the rebuild replaced the
    // Monarch factory while the model's creation-time resolve was still in
    // flight (the pending resolve is dropped with the old factory and no
    // registry event ever fires for the language). Snapshot the live models
    // here instead of bookkeeping past resolutions: it is the only condition
    // that matters.
    this._warmUpLiveModels()
  }

  /** Register a language id into monaco, deduped across grammar + language registrations. */
  private _registerMonacoLanguagePoint(point: IMonacoLanguagePoint): void {
    const languages = this._languages
    const known = this._knownLanguages
    if (languages === undefined || known === undefined) return
    if (known.has(point.id)) return
    known.add(point.id)
    languages.register(point)
  }

  /**
   * Apply `contributes.languages` to monaco: register every declared language id
   * (mapped onto monaco's id space, as grammars are) and, for contributions with
   * a `configuration`, read + apply its language-configuration.json. A registration
   * arrives before monaco loads, so the registry change re-runs this once monaco
   * is live; a re-scan (host restart) unregisters + re-registers and re-applies.
   */
  private _rebuildLanguageRegistrations(): void {
    if (this._languages === undefined || this._knownLanguages === undefined) return
    const configured = new Set<string>()
    for (const definition of languageRegistry.getDefinitions()) {
      const monacoLanguageId = toMonacoLanguageId(definition.id)
      this._registerMonacoLanguagePoint({
        id: monacoLanguageId,
        ...(definition.aliases !== undefined ? { aliases: definition.aliases } : {}),
        ...(definition.extensions !== undefined ? { extensions: definition.extensions } : {}),
        ...(definition.filenames !== undefined ? { filenames: definition.filenames } : {}),
        ...(definition.filenamePatterns !== undefined
          ? { filenamePatterns: definition.filenamePatterns }
          : {}),
        ...(definition.mimetypes !== undefined ? { mimetypes: definition.mimetypes } : {}),
      })
      // Several manifest languages can collapse onto one monaco id (json + jsonc
      // + jsonl → json): the first contribution in registration order wins.
      if (definition.configuration !== undefined && !configured.has(monacoLanguageId)) {
        configured.add(monacoLanguageId)
        void this._applyLanguageConfiguration(monacoLanguageId, definition)
      }
    }
  }

  private async _applyLanguageConfiguration(
    monacoLanguageId: string,
    definition: ILanguageDefinition,
  ): Promise<void> {
    if (definition.configuration === undefined) return
    try {
      const location = URI.joinPath(definition.extensionLocation, definition.configuration)
      const content = await this._fileService.readFileText(location)
      const configuration = parseLanguageConfiguration(content)
      if (configuration === undefined) return
      this._languages?.setLanguageConfiguration(monacoLanguageId, configuration)
      this._logger.info(`language configuration applied for ${monacoLanguageId}`)
    } catch (err) {
      this._logger.warn(
        `failed to apply language configuration for ${monacoLanguageId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  /** Force-resolve the factory of every registered language a live model uses. */
  private _warmUpLiveModels(): void {
    const liveLanguages = this._getLiveLanguages?.()
    if (liveLanguages === undefined) {
      return
    }
    for (const languageId of liveLanguages) {
      this._warmUpLanguage(languageId)
    }
  }

  private _warmUpLanguage(languageId: string): void {
    if (this._monaco !== undefined && this._registeredLanguages.has(languageId)) {
      void this._monaco.TokenizationRegistry.getOrCreate(languageId)
    }
  }

  private async _createTokenizationSupport(
    monacoLanguageId: string,
    definition: IGrammarDefinition,
  ): Promise<(ITokenizationSupport & IDisposable) | null> {
    const factory = this._grammarFactory
    const encodeLanguageId = this._encodeLanguageId
    if (factory === undefined || encodeLanguageId === undefined) {
      return null
    }
    try {
      const { TextMateTokenizationSupport, TokenizationSupportWithLineLimit } =
        await import('./textMateTokenizationSupport.js')
      const result = await factory.createGrammar(definition, monacoLanguageId)
      const support = new TextMateTokenizationSupport(
        result.grammar,
        result.initialState,
        result.containsEmbeddedLanguages,
      )
      this._logger.info(`tokenization support created for ${monacoLanguageId}`)
      // Owned by monaco's TokenizationRegistry through the factory registration:
      // alive as long as the app, disposed only when the factory is re-registered.
      return markAsSingleton(
        new TokenizationSupportWithLineLimit(
          encodeLanguageId(monacoLanguageId),
          support,
          MAX_TOKENIZATION_LINE_LENGTH,
        ),
      )
    } catch (e) {
      this._logger.warn(
        `failed to create TextMate tokenization for ${monacoLanguageId}: ${String(e)}`,
      )
      return null
    }
  }

  setTheme(theme: IRawTheme, colorMap: string[]): void {
    const monaco = this._monaco
    if (monaco === undefined) {
      this._logger.info(
        `setTheme queued (pre-initialize): rules=${theme.settings.length} colorMap=${colorMap.length}`,
      )
      this._pendingTheme = { theme, colorMap }
      return
    }
    this._logger.info(
      `setTheme applied: rules=${theme.settings.length} colorMap=${colorMap.length}`,
    )
    // Only the grammar registry consumes the theme here (token metadata gets
    // colorMap-indexed colorIds). CSS + TokenizationRegistry.setColorMap are
    // monaco's, fed the same table via defineTheme's encodedTokensColors.
    this._grammarFactory?.setTheme(theme, colorMap)
    // Tokens already on screen carry colorIds resolved against the previous
    // theme's color table; monaco never re-tokenizes on its own for a grammar
    // theme change (its setColorMap event only covers languages with a
    // *resolved* support, and fires from the async theme bridge with no
    // ordering guarantee against this call). Fire the change ourselves so
    // every live model on our languages re-tokenizes against the new table.
    const changedLanguages = [...(this._getLiveLanguages?.() ?? [])].filter((languageId) =>
      this._registeredLanguages.has(languageId),
    )
    if (changedLanguages.length > 0) {
      monaco.TokenizationRegistry.handleChange(changedLanguages)
      this._warmUpLiveModels()
    }
  }

  override dispose(): void {
    this._registrations?.dispose()
    this._grammarFactory?.dispose()
    super.dispose()
  }
}
