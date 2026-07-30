/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's AbstractTextMateService (workbench/services/textMate).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  URI,
  createDecorator,
  type Event,
  type IDisposable,
} from '@universe-editor/platform'
import type { IGrammarContribution } from '@universe-editor/extensions-common'
import type { IThemeRegistrationContext } from '../extensions/ExtensionPointTranslator.js'
import { GrammarRegistry, type IGrammarDefinition } from './grammarRegistry.js'

export interface ITextMateService {
  readonly _serviceBrand: undefined

  /** Batch-register `contributes.grammars` entries (translator callback). */
  registerGrammars(
    grammars: readonly IGrammarContribution[],
    context: IThemeRegistrationContext,
  ): IDisposable

  readonly grammarRegistry: GrammarRegistry
  readonly onDidChangeGrammars: Event<void>
}

export const ITextMateService = createDecorator<ITextMateService>('textMateService')

/**
 * TextMate tokenization service. Phase 5.2: owns the {@link GrammarRegistry}
 * fed by the extension-point translator. Grammar factory / wasm / tokenization
 * support land in later phases.
 */
export class TextMateService extends Disposable implements ITextMateService {
  declare readonly _serviceBrand: undefined

  readonly grammarRegistry = new GrammarRegistry()
  readonly onDidChangeGrammars = this.grammarRegistry.onDidChangeGrammars

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
}
