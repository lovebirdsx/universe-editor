/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Adapted from Microsoft VSCode:
 *  - workbench/services/textMate/browser/tokenizationSupport/textMateTokenizationSupport.ts
 *  - workbench/services/textMate/browser/tokenizationSupport/tokenizationSupportWithLineLimit.ts
 *
 *  Telemetry reporting and the per-scope font-info channel (vscode-textmate
 *  9.x `fonts`) are dropped: monaco 0.55's EncodedTokenizationResult only
 *  carries (tokens, endState).
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Emitter, type Event } from '@universe-editor/platform'
import { TokenMetadata } from 'monaco-editor/esm/vs/editor/common/encodedTokenAttributes.js'
import {
  EncodedTokenizationResult,
  type IState,
  type ITokenizationSupport,
} from 'monaco-editor/esm/vs/editor/common/languages.js'
import { nullTokenizeEncoded } from 'monaco-editor/esm/vs/editor/common/languages/nullTokenize.js'
import type { IGrammar, StateStack } from 'vscode-textmate'

/** VSCode `editor.maxTokenizationLineLength` default: longer lines fall back to
 *  a single whole-line token instead of running the grammar. */
export const MAX_TOKENIZATION_LINE_LENGTH = 20_000

/** Single-line grammar time budget in ms (VSCode passes 500 to tokenizeLine2). */
const TOKENIZATION_TIME_LIMIT_MS = 500

export class TextMateTokenizationSupport extends Disposable implements ITokenizationSupport {
  private readonly _seenLanguages: boolean[] = []
  private readonly _onDidEncounterLanguage = this._register(new Emitter<number>())
  readonly onDidEncounterLanguage: Event<number> = this._onDidEncounterLanguage.event

  constructor(
    private readonly _grammar: IGrammar,
    private readonly _initialState: StateStack,
    private readonly _containsEmbeddedLanguages: boolean,
  ) {
    super()
  }

  getInitialState(): IState {
    return this._initialState
  }

  tokenizeEncoded(line: string, _hasEOL: boolean, state: StateStack): EncodedTokenizationResult {
    const textMateResult = this._grammar.tokenizeLine2(line, state, TOKENIZATION_TIME_LIMIT_MS)

    if (textMateResult.stoppedEarly) {
      console.warn(`Time limit reached when tokenizing line: ${line.substring(0, 100)}`)
      // Return the state at the beginning of the line (do not advance the machine).
      return new EncodedTokenizationResult(textMateResult.tokens, state)
    }

    if (this._containsEmbeddedLanguages) {
      const seenLanguages = this._seenLanguages
      const tokens = textMateResult.tokens
      // Check whether any embedded language was hit for the first time.
      for (let i = 0, len = tokens.length >>> 1; i < len; i++) {
        const metadata = tokens[(i << 1) + 1]!
        const languageId = TokenMetadata.getLanguageId(metadata)
        if (!seenLanguages[languageId]) {
          seenLanguages[languageId] = true
          this._onDidEncounterLanguage.fire(languageId)
        }
      }
    }

    // Reuse the incoming state object when the machine did not move, so
    // downstream diffing can stop early (VSCode endState trick).
    const endState = state.equals(textMateResult.ruleStack) ? state : textMateResult.ruleStack
    return new EncodedTokenizationResult(textMateResult.tokens, endState)
  }
}

/**
 * Line-length gate (VSCode `TokenizationSupportWithLineLimit`): lines at or
 * above the limit get a whole-line default-colored token instead of running
 * the grammar (pathological minified files).
 */
export class TokenizationSupportWithLineLimit extends Disposable implements ITokenizationSupport {
  constructor(
    private readonly _encodedLanguageId: number,
    private readonly _actual: TextMateTokenizationSupport,
    private readonly _maxTokenizationLineLength: number,
  ) {
    super()
  }

  getInitialState(): IState {
    return this._actual.getInitialState()
  }

  tokenizeEncoded(line: string, hasEOL: boolean, state: IState): EncodedTokenizationResult {
    if (line.length >= this._maxTokenizationLineLength) {
      return nullTokenizeEncoded(this._encodedLanguageId, state)
    }
    return this._actual.tokenizeEncoded(line, hasEOL, state as StateStack)
  }
}
