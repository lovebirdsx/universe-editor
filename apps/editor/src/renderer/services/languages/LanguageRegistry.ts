/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registry for `contributes.languages` entries — the declarative half of a
 *  language: id, file associations (extensions / filenames / filenamePatterns /
 *  mimetypes) and the extensionLocation context the language-configuration.json
 *  is resolved against. `resourceLanguage.ts` queries it synchronously (the
 *  model registry calls it during createModel), so it is a module singleton.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  URI,
  compileGlobMatcher,
  toDisposable,
  type Event,
  type IDisposable,
} from '@universe-editor/platform'
import type { ILanguageContribution } from '@universe-editor/extensions-common'

/** A validated language registration: the manifest contribution plus the extension root. */
export interface ILanguageDefinition extends ILanguageContribution {
  /** Absolute URI of the extension root (configuration path resolved against it). */
  readonly extensionLocation: URI
  readonly sourceExtensionId: string
}

/** Normalize a manifest `extensions` entry to a lowercased, dot-prefixed form. */
function normalizeExtension(extension: string): string {
  const lower = extension.toLowerCase()
  return lower.startsWith('.') ? lower : `.${lower}`
}

interface IPatternEntry {
  readonly definition: ILanguageDefinition
  readonly match: (lowerPath: string) => boolean
}

/**
 * Registry for `contributes.languages` entries (VSCode `LanguagesRegistry`
 * 对等物, declarative association half): filename → definition, extension →
 * definition, filenamePatterns → definition. Keys are lowercased (the built-in
 * `resourceLanguage` tables match lowercased names, so contributions do too).
 */
export class LanguageRegistry {
  private readonly _byFilename = new Map<string, ILanguageDefinition>()
  private readonly _byExtension = new Map<string, ILanguageDefinition>()
  private _patterns: IPatternEntry[] = []
  private _definitions: ILanguageDefinition[] = []

  private readonly _onDidChangeLanguages = new Emitter<void>()
  readonly onDidChangeLanguages: Event<void> = this._onDidChangeLanguages.event

  /** Register a batch; returns a Disposable that unregisters exactly these. */
  registerLanguages(definitions: readonly ILanguageDefinition[]): IDisposable {
    for (const def of definitions) {
      for (const filename of def.filenames ?? []) {
        this._byFilename.set(filename.toLowerCase(), def)
      }
      for (const extension of def.extensions ?? []) {
        this._byExtension.set(normalizeExtension(extension), def)
      }
      for (const pattern of def.filenamePatterns ?? []) {
        // Lowercased so a `*.SQL` glob still matches `foo.sql` on every platform,
        // matching the case-insensitive filename/extension lookups around it.
        this._patterns.push({ definition: def, match: compileGlobMatcher(pattern.toLowerCase()) })
      }
    }
    this._definitions.push(...definitions)
    this._onDidChangeLanguages.fire()
    return toDisposable(() => this._unregister(definitions))
  }

  private _unregister(definitions: readonly ILanguageDefinition[]): void {
    for (const def of definitions) {
      for (const filename of def.filenames ?? []) {
        if (this._byFilename.get(filename.toLowerCase()) === def) {
          this._byFilename.delete(filename.toLowerCase())
        }
      }
      for (const extension of def.extensions ?? []) {
        if (this._byExtension.get(normalizeExtension(extension)) === def) {
          this._byExtension.delete(normalizeExtension(extension))
        }
      }
    }
    const removed = new Set(definitions)
    this._patterns = this._patterns.filter((entry) => !removed.has(entry.definition))
    this._definitions = this._definitions.filter((def) => !removed.has(def))
    this._onDidChangeLanguages.fire()
  }

  lookupByFilename(lowerBasename: string): ILanguageDefinition | undefined {
    return this._byFilename.get(lowerBasename)
  }

  lookupByExtension(lowerExtension: string): ILanguageDefinition | undefined {
    return this._byExtension.get(lowerExtension)
  }

  /**
   * Match `filenamePatterns` against a forward-slash path (lowercased). Later
   * registrations win, so the list is walked newest-first.
   */
  lookupByPattern(lowerPath: string): ILanguageDefinition | undefined {
    for (let i = this._patterns.length - 1; i >= 0; i--) {
      if (this._patterns[i]!.match(lowerPath)) return this._patterns[i]!.definition
    }
    return undefined
  }

  /** Every registered definition, in registration order (monaco application). */
  getDefinitions(): readonly ILanguageDefinition[] {
    return this._definitions
  }

  /** Test-only: drop everything. */
  _resetForTests(): void {
    this._byFilename.clear()
    this._byExtension.clear()
    this._patterns.length = 0
    this._definitions = []
  }
}

/** Shared instance queried by `resourceLanguage.languageForResource`. */
export const languageRegistry = new LanguageRegistry()
