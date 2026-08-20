/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Re-resolves the language of open plaintext models after `contributes.languages`
 *  registrations land (VSCode parity). On cold start the workbench restores
 *  editors (createModel + languageForResource) before the extension pipeline
 *  translates language contributions, so a file whose association comes purely
 *  from an extension resolves to plaintext and would stay that way forever —
 *  the mirror pushed to the extension host then carries the wrong languageId
 *  and `onLanguage:` activation never fires for it.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, URI, type IWorkbenchContribution } from '@universe-editor/platform'
import { languageRegistry } from '../services/languages/LanguageRegistry.js'
import { languageForResource } from '../workbench/files/resourceLanguage.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'

interface IModelLike {
  isDisposed(): boolean
  getLanguageId(): string
  readonly uri: { toString(): string }
}

interface IMonacoLike {
  editor: {
    getModels(): readonly IModelLike[]
    setModelLanguage(model: IModelLike, languageId: string): void
  }
  languages: {
    getLanguages(): readonly { id: string }[]
    register(language: { id: string }): void
  }
}

/**
 * Upgrade every open plaintext model whose resource now resolves to a
 * contributed language. Only plaintext models are touched: a model already
 * carrying a real language keeps it (an explicit user choice or an earlier
 * resolution must not be overridden by a late-registering extension).
 * Exported for tests.
 */
export function resyncModelLanguages(monaco: IMonacoLike): void {
  let known: Set<string> | undefined
  for (const model of monaco.editor.getModels()) {
    if (model.isDisposed() || model.getLanguageId() !== 'plaintext') continue
    const resolved = languageForResource(URI.parse(model.uri.toString()))
    if (resolved === 'plaintext') continue
    // Monaco silently falls back to plaintext for ids its registry doesn't
    // know — self-register (idempotent) so this sweep never depends on the
    // TextMateService rebuild having run first on the same registry event.
    known ??= new Set(monaco.languages.getLanguages().map((l) => l.id))
    if (!known.has(resolved)) {
      monaco.languages.register({ id: resolved })
      known.add(resolved)
    }
    console.info(
      `[languages] re-resolved ${model.uri.toString()} → ${resolved} after language contribution registration`,
    )
    monaco.editor.setModelLanguage(model, resolved)
  }
}

export class ModelLanguageResyncContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      languageRegistry.onDidChangeLanguages(() => {
        // Defer past the synchronous listener chain of the same registry event
        // (TextMateService re-registers the monaco language points there).
        queueMicrotask(() => {
          const monaco = MonacoLoader.peek()
          if (monaco) resyncModelLanguages(monaco)
        })
      }),
    )
  }
}
