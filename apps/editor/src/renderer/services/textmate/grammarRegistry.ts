/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's TMScopeRegistry (workbench/services/textMate/common/TMScopeRegistry.ts).
 *--------------------------------------------------------------------------------------------*/

import { Emitter, toDisposable, type Event, type IDisposable, URI } from '@universe-editor/platform'
import type { IGrammarContribution } from '@universe-editor/extensions-common'

/**
 * A validated grammar registration: the manifest contribution plus the
 * resolved absolute location and the contributing extension id.
 */
export interface IGrammarDefinition extends IGrammarContribution {
  /** Absolute URI of the grammar file (extensionLocation joined with `path`). */
  readonly location: URI
  readonly sourceExtensionId: string
}

/**
 * Registry for `contributes.grammars` entries (VSCode `TMScopeRegistry` 对等物):
 * scopeName → definition, languageId → scopeName, and the injection map
 * (target scope → injecting scopeNames). Consumed by the TextMate service when
 * (re)building its grammar factory.
 */
export class GrammarRegistry {
  private readonly _scopeRegistry = new Map<string, IGrammarDefinition>()
  // Reference-valued so unregister can tell "this exact registration" apart
  // from a later batch that claimed the same language with the same scopeName.
  private readonly _languageToScope = new Map<string, IGrammarDefinition>()
  private readonly _injections = new Map<string, string[]>()

  private readonly _onDidChangeGrammars = new Emitter<void>()
  readonly onDidChangeGrammars: Event<void> = this._onDidChangeGrammars.event

  /** Register a batch; returns a Disposable that unregisters exactly these. */
  registerGrammars(definitions: readonly IGrammarDefinition[]): IDisposable {
    for (const def of definitions) {
      const existing = this._scopeRegistry.get(def.scopeName)
      if (existing !== undefined && existing.location.toString() !== def.location.toString()) {
        console.warn(
          `Overwriting grammar scope ${def.scopeName}: ${existing.location.path} → ${def.location.path}`,
        )
      }
      this._scopeRegistry.set(def.scopeName, def)
      if (def.language !== undefined) {
        this._languageToScope.set(def.language, def)
      }
      if (def.injectTo !== undefined) {
        for (const target of def.injectTo) {
          const list = this._injections.get(target) ?? []
          list.push(def.scopeName)
          this._injections.set(target, list)
        }
      }
    }
    this._onDidChangeGrammars.fire()
    return toDisposable(() => this._unregister(definitions))
  }

  private _unregister(definitions: readonly IGrammarDefinition[]): void {
    for (const def of definitions) {
      // Only remove if this exact registration is still current (a later batch
      // may have overwritten the same scope).
      if (this._scopeRegistry.get(def.scopeName) === def) {
        this._scopeRegistry.delete(def.scopeName)
      }
      if (def.language !== undefined && this._languageToScope.get(def.language) === def) {
        this._languageToScope.delete(def.language)
      }
      if (def.injectTo !== undefined) {
        for (const target of def.injectTo) {
          const list = this._injections.get(target)
          if (list !== undefined) {
            const next = list.filter((s) => s !== def.scopeName)
            if (next.length > 0) {
              this._injections.set(target, next)
            } else {
              this._injections.delete(target)
            }
          }
        }
      }
    }
    this._onDidChangeGrammars.fire()
  }

  getGrammarDefinition(scopeName: string): IGrammarDefinition | undefined {
    return this._scopeRegistry.get(scopeName)
  }

  /** VSCode `getInjections`: prefix-wise, so 'a.b.c' collects injections for 'a', 'a.b', 'a.b.c'. */
  getInjections(scopeName: string): readonly string[] {
    const scopeParts = scopeName.split('.')
    let injections: string[] = []
    for (let i = 1; i <= scopeParts.length; i++) {
      const subScopeName = scopeParts.slice(0, i).join('.')
      injections = [...injections, ...(this._injections.get(subScopeName) ?? [])]
    }
    return injections
  }

  getScopeForLanguage(languageId: string): string | undefined {
    return this._languageToScope.get(languageId)?.scopeName
  }

  getRegisteredLanguages(): readonly string[] {
    return [...this._languageToScope.keys()]
  }

  getDefinitions(): readonly IGrammarDefinition[] {
    return [...this._scopeRegistry.values()]
  }
}
