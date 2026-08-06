// Monaco's deep ESM path ships no .d.ts. We only consume EditorExtensionsRegistry
// via the IMonacoEditorExtensionsRegistry shape defined in monacoActionsBridge,
// so an empty ambient declaration suffices.
declare module 'monaco-editor/esm/vs/editor/browser/editorExtensions.js'

// Same deal for standaloneServices: no shipped .d.ts. We need
// StandaloneServices.initialize(overrides) to lock our override services in
// before any service is first resolved, and StandaloneServices.get(...) to
// reach the resolved ICodeEditorService (see MonacoLoader).
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  import type { editor } from 'monaco-editor'
  export namespace StandaloneServices {
    function initialize(overrides: editor.IEditorOverrideServices): unknown
    function get<T>(id: unknown): T
  }
}

// ICodeEditorService is a service decorator with no shipped .d.ts; we only use it
// as the lookup key for StandaloneServices.get (see MonacoLoader).
declare module 'monaco-editor/esm/vs/editor/browser/services/codeEditorService.js' {
  export const ICodeEditorService: unknown
}

// ICommandService decorator, used as the lookup key for StandaloneServices.get so
// the workbench can invoke monaco-internal commands like the references-peek
// `openReference` (see MonacoLoader / PeekNavigationContribution). CommandsRegistry
// is monaco's own command registry — a separate registry from the platform one —
// which trusted-hover `command:` links dispatch through (see ScmBlameContribution).
declare module 'monaco-editor/esm/vs/platform/commands/common/commands.js' {
  export const ICommandService: unknown
  export const CommandsRegistry: {
    registerCommand(
      id: string,
      handler: (accessor: unknown, ...args: unknown[]) => unknown,
    ): { dispose(): void }
  }
}

// IListService decorator + lookup key for StandaloneServices.get. We reach
// `lastFocusedList` to mirror keyboard focus onto the selection inside the
// references peek (see PeekNavigationContribution).
declare module 'monaco-editor/esm/vs/platform/list/browser/listService.js' {
  export const IListService: unknown
}

// ILanguageFeaturesService decorator + lookup key for StandaloneServices.get. We
// reach its `documentPasteEditProvider` registry to register the markdown
// paste-to-link provider (no public monaco.languages.* API; see
// MarkdownPasteContribution / MonacoLoader).
declare module 'monaco-editor/esm/vs/editor/common/services/languageFeatures.js' {
  export const ILanguageFeaturesService: unknown
}

// IBulkEditService decorator + lookup key for StandaloneServices.get. We resolve
// the effective service (our FileBulkEditService override) so the E2E probe can
// drive the real drop/paste-to-link execution path end to end (see MonacoLoader).
declare module 'monaco-editor/esm/vs/editor/browser/services/bulkEditService.js' {
  export const IBulkEditService: unknown
}

// The built-in markdown Monarch grammar ships no .d.ts. We clone its `language`
// object to add YAML frontmatter highlighting (see monacoMarkdownFrontmatter).
declare module 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js' {
  import type { languages } from 'monaco-editor'
  export const language: languages.IMonarchLanguage
  export const conf: languages.LanguageConfiguration
}

// IConfigurationService decorator + lookup key for StandaloneServices.get. The
// E2E semantic-token probe reads `editor.semanticHighlighting` off it to check
// the standalone config gate.
declare module 'monaco-editor/esm/vs/platform/configuration/common/configuration.js' {
  export const IConfigurationService: unknown
}

// IStandaloneThemeService decorator + lookup key for StandaloneServices.get. The
// E2E semantic-token probe resolves a foreground color-id to its hex through the
// active theme's token color map.
declare module 'monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js' {
  export const IStandaloneThemeService: unknown
}

// StandaloneThemeService concrete class + the (unexported) StandaloneTheme shape.
// The semantic-theme bridge resolves the live service via
// StandaloneServices.get(IStandaloneThemeService), reads its `_knownThemes` map,
// and clones active themes via `Object.create` onto a subclass of the StandaloneTheme
// prototype (the class itself is not exported, so `extends` is impossible).
// No shipped .d.ts.
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneThemeService.js' {
  export const VS_LIGHT_THEME_NAME: string
  export const VS_DARK_THEME_NAME: string
  export const HC_BLACK_THEME_NAME: string
  export const HC_LIGHT_THEME_NAME: string

  export interface ITokenStyleMetadataResult {
    foreground: number | undefined
    italic: boolean | undefined
    bold: boolean | undefined
    underline: boolean | undefined
    strikethrough: boolean | undefined
  }

  /** Structural shape of the unexported StandaloneTheme instances. */
  export interface IStandaloneThemeLike {
    semanticHighlighting: boolean
    readonly themeData: unknown
    readonly tokenTheme: { getColorMap(): Array<{ toString(): string }> }
    notifyBaseUpdated(): void
    getTokenStyleMetadata(
      type: string,
      modifiers: string[],
      modelLanguage: string,
    ): ITokenStyleMetadataResult | undefined
  }

  export class StandaloneThemeService {
    readonly _knownThemes: Map<string, IStandaloneThemeLike>
    _theme: IStandaloneThemeLike
    setTheme(themeName: string): void
    getColorTheme(): IStandaloneThemeLike
  }
}


// IInstantiationService decorator, used as the lookup key for
// StandaloneServices.get so MonacoLoader can capture the process-level root
// instantiation service (see monacoHoverDelegateGuard).
declare module 'monaco-editor/esm/vs/platform/instantiation/common/instantiation.js' {
  export const IInstantiationService: unknown
}

// Global hover-delegate factory (module-level singleton in monaco). The hover
// guard reseats it onto a root-captured closure after diff editors leave it
// dangling on a disposed child IInstantiationService. Typed structurally in
// monacoHoverDelegateGuard.ts; no shipped .d.ts.
declare module 'monaco-editor/esm/vs/base/browser/ui/hover/hoverDelegateFactory.js'

// WorkbenchHoverDelegate ctor consumed by the hover guard (typed structurally
// there); no shipped .d.ts.
declare module 'monaco-editor/esm/vs/platform/hover/browser/hover.js'

// TokenMetadata decode helpers (the bit-layout const enums are erased in the
// esm build, so our own encodedTokenAttributes.ts carries runtime constants;
// the roundtrip test pins our encoding against this decoder). No shipped .d.ts.
declare module 'monaco-editor/esm/vs/editor/common/encodedTokenAttributes.js' {
  export class TokenMetadata {
    static getLanguageId(metadata: number): number
    static getTokenType(metadata: number): number
    static containsBalancedBrackets(metadata: number): boolean
    static getFontStyle(metadata: number): number
    static getForeground(metadata: number): number
    static getBackground(metadata: number): number
    static getClassNameFromMetadata(metadata: number): string
    static getInlineStyleFromMetadata(metadata: number, colorMap: string[]): string
    static getPresentationFromMetadata(metadata: number): {
      foreground: number
      italic: boolean
      bold: boolean
      underline: boolean
      strikethrough: boolean
    }
  }
}

// Internal tokenization registry + support plumbing the TextMate engine plugs
// into (VSCode registers its TextMateTokenizationSupport the same way). No
// shipped .d.ts; shapes mirrored from monaco 0.55 esm sources.
declare module 'monaco-editor/esm/vs/editor/common/languages.js' {
  export interface IState {
    clone(): IState
    equals(other: IState): boolean
  }

  export class EncodedTokenizationResult {
    constructor(tokens: Uint32Array, endState: IState)
    readonly tokens: Uint32Array
    readonly endState: IState
  }

  export interface ITokenizationSupport {
    getInitialState(): IState
    tokenizeEncoded(line: string, hasEOL: boolean, state: IState): EncodedTokenizationResult
  }

  export class LazyTokenizationSupport {
    constructor(
      createSupport: () => Promise<(ITokenizationSupport & { dispose(): void }) | null>,
    )
    readonly tokenizationSupport: Promise<(ITokenizationSupport & { dispose(): void }) | null>
    dispose(): void
  }

  export const TokenizationRegistry: {
    registerFactory(languageId: string, factory: LazyTokenizationSupport): { dispose(): void }
    getOrCreate(languageId: string): Promise<ITokenizationSupport | null>
    get(languageId: string): ITokenizationSupport | null
    handleChange(languageIds: string[]): void
    onDidChange(
      listener: (e: {
        changedLanguages: readonly string[]
        changedColorMap: boolean
      }) => void,
    ): { dispose(): void }
  }
}

// Whole-line fallback token for over-long lines + the NullState sentinel. No
// shipped .d.ts.
declare module 'monaco-editor/esm/vs/editor/common/languages/nullTokenize.js' {
  import type {
    EncodedTokenizationResult,
    IState,
  } from 'monaco-editor/esm/vs/editor/common/languages.js'
  export const NullState: IState
  export function nullTokenizeEncoded(
    languageId: number,
    state: IState | null,
  ): EncodedTokenizationResult
}

// Monaco's error-handler singleton (module-level in vs/base/common/errors). The
// esm build drops ErrorHandler.setUnexpectedErrorHandler, so the workbench
// reassigns the `unexpectedErrorHandler` instance field directly to route
// Monaco-swallowed errors into onUnexpectedError (see monacoErrorRouting).
declare module 'monaco-editor/esm/vs/base/common/errors.js' {
  export const errorHandler: { unexpectedErrorHandler: (e: unknown) => void }
}

