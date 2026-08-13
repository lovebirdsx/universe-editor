/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Adapted from Microsoft VSCode src/vs/workbench/services/textMate/common/TMGrammarFactory.ts.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type ILogger, NullLogger } from '@universe-editor/platform'
import * as vscodeTextmate from 'vscode-textmate'
import type { IGrammar, IOnigLib, IRawGrammar, IRawTheme, StateStack } from 'vscode-textmate'
import type { StandardTokenType } from './encodedTokenAttributes.js'
import { StandardTokenType as StandardTokenTypeValues } from './encodedTokenAttributes.js'
import type { GrammarRegistry, IGrammarDefinition } from './grammarRegistry.js'
import { toMonacoLanguageId } from './languageIdMapping.js'

/** Host capabilities the factory needs (kept tiny for unit-test stubs). */
export interface ITMGrammarFactoryHost {
  readonly logger?: ILogger
  readFile(resource: string): Promise<string>
}

export interface ICreateGrammarResult {
  readonly grammar: IGrammar
  readonly initialState: StateStack
  readonly containsEmbeddedLanguages: boolean
}

const MANIFEST_TOKEN_TYPES: Record<string, StandardTokenType> = {
  comment: StandardTokenTypeValues.Comment,
  string: StandardTokenTypeValues.String,
  regex: StandardTokenTypeValues.RegEx,
  other: StandardTokenTypeValues.Other,
}

/**
 * Owns the vscode-textmate `Registry`: lazy grammar loading from the
 * {@link GrammarRegistry} definitions, injection resolution, and theme
 * application. Grammar metadata (language id bit, embedded language ids) is
 * encoded through the supplied `encodeLanguageId` (monaco's codec).
 */
export class TMGrammarFactory extends Disposable {
  private readonly _initialState: StateStack = vscodeTextmate.INITIAL
  private readonly _grammarRegistry: vscodeTextmate.Registry

  constructor(
    private readonly _host: ITMGrammarFactoryHost,
    private readonly _grammars: GrammarRegistry,
    onigLib: Promise<IOnigLib>,
    private readonly _encodeLanguageId: (languageId: string) => number,
  ) {
    super()
    this._grammarRegistry = this._register(
      new vscodeTextmate.Registry({
        onigLib,
        loadGrammar: async (scopeName: string): Promise<IRawGrammar | null> => {
          const definition = this._grammars.getGrammarDefinition(scopeName)
          if (definition === undefined) {
            this._log((l) => l.trace, `No grammar found for scope ${scopeName}`)
            return null
          }
          try {
            // 本机路径：grammar 定义来自随扩展安装的本地 file: 资源，不随远端工作区变化。
            const content = await this._host.readFile(definition.location.fsPath)
            return vscodeTextmate.parseRawGrammar(content, definition.location.path)
          } catch (e) {
            this._log(
              (l) => l.error,
              `Failed to load grammar ${scopeName} from ${definition.location.fsPath}: ${String(e)}`,
            )
            return null
          }
        },
        getInjections: (scopeName: string) => {
          const injections = this._grammars.getInjections(scopeName)
          return injections.length > 0 ? [...injections] : undefined
        },
      }),
    )
  }

  private _log(pick: (l: ILogger) => ILogger['trace'] | ILogger['error'], message: string): void {
    const logger = this._host.logger ?? new NullLogger()
    pick(logger).call(logger, message)
  }

  /** Forward a color theme into the textmate registry (VSCode `setTheme`). */
  setTheme(theme: IRawTheme, colorMap: string[]): void {
    this._grammarRegistry.setTheme(theme, colorMap)
  }

  getColorMap(): string[] {
    return this._grammarRegistry.getColorMap()
  }

  /** VSCode `createGrammar`: load the grammar for a definition, with its
   *  embedded-language/token-type/bracket configuration encoded for metadata.
   *  `languageId` is the id whose encoded form goes into token metadata (the
   *  monaco-side language id, after VSCode→monaco mapping by the caller). */
  async createGrammar(
    definition: IGrammarDefinition,
    languageId: string,
  ): Promise<ICreateGrammarResult> {
    const embeddedLanguages = this._collectEmbeddedLanguages(definition)
    const containsEmbeddedLanguages = Object.keys(embeddedLanguages).length > 0
    const encodedLanguageId = this._encodeLanguageId(languageId)

    const tokenTypes: Record<string, StandardTokenType> = {}
    for (const [selector, tokenType] of Object.entries(definition.tokenTypes ?? {})) {
      tokenTypes[selector] = MANIFEST_TOKEN_TYPES[tokenType] ?? StandardTokenTypeValues.Other
    }

    const grammar = await this._grammarRegistry.loadGrammarWithConfiguration(
      definition.scopeName,
      encodedLanguageId,
      {
        embeddedLanguages,
        tokenTypes,
        balancedBracketSelectors: definition.balancedBracketScopes ?? ['*'],
        unbalancedBracketSelectors: definition.unbalancedBracketScopes ?? [],
      },
    )
    if (grammar === null) {
      throw new Error(
        `Failed to load grammar for language ${languageId} (scope ${definition.scopeName})`,
      )
    }
    return { grammar, initialState: this._initialState, containsEmbeddedLanguages }
  }

  /** Merge the grammar's own embeddedLanguages with those contributed by
   *  grammars injecting into it (VSCode `_getInjectedEmbeddedLanguages`).
   *  Values pass through the VSCode→monaco id mapping before encoding. */
  private _collectEmbeddedLanguages(definition: IGrammarDefinition): Record<string, number> {
    const result: Record<string, number> = {}
    const merge = (map: Record<string, string> | undefined): void => {
      for (const [scope, language] of Object.entries(map ?? {})) {
        result[scope] = this._encodeLanguageId(toMonacoLanguageId(language))
      }
    }
    merge(definition.embeddedLanguages)
    for (const injectingScope of this._grammars.getInjections(definition.scopeName)) {
      merge(this._grammars.getGrammarDefinition(injectingScope)?.embeddedLanguages)
    }
    return result
  }
}
