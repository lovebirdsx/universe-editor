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
import type { IGrammarContribution } from '@universe-editor/extensions-common'
import type { Color } from 'monaco-editor/esm/vs/base/common/color.js'
import type {
  ITokenizationSupport,
  LazyTokenizationSupport as LazyTokenizationSupportClass,
} from 'monaco-editor/esm/vs/editor/common/languages.js'
import type { IRawTheme } from 'vscode-textmate'
import type { IThemeRegistrationContext } from '../extensions/ExtensionPointTranslator.js'
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

  readonly grammarRegistry: GrammarRegistry
  readonly onDidChangeGrammars: Event<void>

  /**
   * Wire into monaco's TokenizationRegistry. Must run after the monaco
   * package finished initializing (standalone services lock on first use).
   */
  initialize(monaco: {
    languages: { getEncodedLanguageId(languageId: string): number }
    editor: { getModels(): readonly { getLanguageId(): string }[] }
  }): Promise<void>

  /** Forward a color theme's token rules into the textmate registry, the
   *  monaco color map, and the `.mtkN` classifier stylesheet (VSCode
   *  `_updateTheme`). Safe before initialize(): the theme is replayed then. */
  setTheme(theme: IRawTheme, colorMap: string[]): void
}

export const ITextMateService = createDecorator<ITextMateService>('textMateService')

/** monaco deep-import surface resolved during initialize(). */
interface IMonacoTokenizationBindings {
  readonly TokenizationRegistry: {
    registerFactory(languageId: string, factory: LazyTokenizationSupportClass): { dispose(): void }
    getOrCreate(languageId: string): Promise<ITokenizationSupport | null>
    setColorMap(colorMap: Color[]): void
    onDidChange(
      listener: (e: { changedLanguages: readonly string[]; changedColorMap: boolean }) => void,
    ): IDisposable
  }
  readonly LazyTokenizationSupport: new (
    createSupport: () => Promise<(ITokenizationSupport & IDisposable) | null>,
  ) => LazyTokenizationSupportClass
  readonly Color: { fromHex(hex: string): Color }
  readonly generateTokensCSSForColorMap: (colorMap: readonly Color[]) => string
}

function toColorMap(
  colorMap: readonly string[],
  Color: IMonacoTokenizationBindings['Color'],
): Color[] {
  // Index 0 is ColorId.None — always null (VSCode toColorMap).
  const result: Color[] = [null as unknown as Color]
  for (let i = 1, len = colorMap.length; i < len; i++) {
    result[i] = Color.fromHex(colorMap[i]!)
  }
  return result
}

export class TextMateService extends Disposable implements ITextMateService {
  declare readonly _serviceBrand: undefined

  readonly grammarRegistry = new GrammarRegistry()
  readonly onDidChangeGrammars = this.grammarRegistry.onDidChangeGrammars

  private readonly _logger: ILogger
  private _monaco: IMonacoTokenizationBindings | undefined
  private _encodeLanguageId: ((languageId: string) => number) | undefined
  private _registrations: DisposableStore | undefined
  private _grammarFactory: TMGrammarFactory | undefined
  private _styleElement: HTMLStyleElement | undefined
  private _pendingTheme: { theme: IRawTheme; colorMap: string[] } | undefined
  /** Languages whose support we must re-warm after the next rebuild. */
  private readonly _languagesToWarm = new Set<string>()
  private _hasResolvedSupportOnce = false

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
      location: URI.joinPath(URI.file(context.extensionLocation), grammar.path),
      sourceExtensionId: context.extensionId,
    }))
    return this.grammarRegistry.registerGrammars(definitions)
  }

  async initialize(monaco: {
    languages: { getEncodedLanguageId(languageId: string): number }
    editor: { getModels(): readonly { getLanguageId(): string }[] }
  }): Promise<void> {
    if (this._monaco !== undefined) {
      return
    }
    const [languages, color, tokenization] = await Promise.all([
      import('monaco-editor/esm/vs/editor/common/languages.js'),
      import('monaco-editor/esm/vs/base/common/color.js'),
      import('monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js'),
    ])
    this._monaco = {
      TokenizationRegistry: languages.TokenizationRegistry,
      LazyTokenizationSupport: languages.LazyTokenizationSupport,
      Color: color.Color,
      generateTokensCSSForColorMap: tokenization.generateTokensCSSForColorMap,
    }
    this._encodeLanguageId = (languageId) => monaco.languages.getEncodedLanguageId(languageId)
    this._register(this.grammarRegistry.onDidChangeGrammars(() => this._rebuildRegistrations()))
    this._register(
      languages.TokenizationRegistry.onDidChange((e) => {
        if (!e.changedColorMap) {
          this._hasResolvedSupportOnce = true
        }
      }),
    )
    // Models created before this initialize resolved their Monarch support
    // through TextModel's creation-time warm-up; registering our factories
    // disposes those supports, so they must resolve again through ours.
    for (const model of monaco.editor.getModels()) {
      this._languagesToWarm.add(model.getLanguageId())
    }
    this._rebuildRegistrations()
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
          readFile: (fsPath) => this._fileService.readFileText(URI.file(fsPath)),
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
      const lazySupport = new monaco.LazyTokenizationSupport(() =>
        this._createTokenizationSupport(monacoLanguageId, definition),
      )
      registrations.add(lazySupport)
      registrations.add(monaco.TokenizationRegistry.registerFactory(monacoLanguageId, lazySupport))
    }
    this._registrations = this._register(registrations)
    this._logger.trace(
      `registered ${seenLanguages.size} TextMate grammar factories: ${[...seenLanguages].join(', ')}`,
    )

    // VSCode _handleGrammarsExtPoint warms up `createdModes`: a fresh factory
    // only resolves when someone calls getOrCreate. TextModel does that once
    // at creation time, so models opened before this rebuild — and any model
    // whose support we just unregistered — would otherwise stay untokenized.
    for (const languageId of this._languagesToWarm) {
      if (seenLanguages.has(languageId)) {
        void monaco.TokenizationRegistry.getOrCreate(languageId)
      }
    }
    this._languagesToWarm.clear()
    if (this._hasResolvedSupportOnce) {
      // Some language had a resolved support before this rebuild: the rebuild
      // unregistered it, and its model never re-resolves on its own.
      for (const languageId of seenLanguages) {
        void monaco.TokenizationRegistry.getOrCreate(languageId)
      }
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
      // A resolved support means a live model uses this language: after every
      // later rebuild the new factory must resolve again for it.
      this._languagesToWarm.add(monacoLanguageId)
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
    if (this._monaco === undefined) {
      this._pendingTheme = { theme, colorMap }
      return
    }

    this._grammarFactory?.setTheme(theme, colorMap)
    const effectiveColorMap = this._grammarFactory?.getColorMap() ?? colorMap
    const colors = toColorMap(effectiveColorMap, this._monaco.Color)
    this._monaco.TokenizationRegistry.setColorMap(colors)
    if (typeof document !== 'undefined') {
      if (this._styleElement === undefined) {
        this._styleElement = document.createElement('style')
        this._styleElement.className = 'contributedTextMateTokens'
        document.head.appendChild(this._styleElement)
      }
      this._styleElement.textContent = this._monaco.generateTokensCSSForColorMap(colors)
    }
  }

  override dispose(): void {
    this._registrations?.dispose()
    this._grammarFactory?.dispose()
    this._styleElement?.remove()
    super.dispose()
  }
}
