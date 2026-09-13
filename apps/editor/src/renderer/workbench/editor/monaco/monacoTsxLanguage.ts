/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers `typescriptreact` as a first-class monaco language (VSCode's own id
 *  for `.tsx`). Monaco's basic-languages only ship `typescript`, so without this
 *  the id would have to collapse onto `typescript` — and a collapsed id loses the
 *  tsx TextMate grammar entirely (first grammar per monaco id wins, and source.ts
 *  is declared first), which is exactly how JSX tag names lost their color.
 *
 *  Everything here is parity work for the new id: monaco's TypeScript language
 *  configuration (brackets / comments / auto-close), its Monarch grammar as the
 *  pre-TextMate fallback, and the handful of built-in ts-worker features
 *  MonacoLoader still leaves enabled. The TS/JS *language service* features
 *  (hover, definitions, completion, …) come from the typescript extension's LSP,
 *  which already registers against `typescriptreact`.
 *--------------------------------------------------------------------------------------------*/

import type * as monaco from 'monaco-editor'
import { NullLogger, type ILogger } from '@universe-editor/platform'

export const TSX_LANGUAGE_ID = 'typescriptreact'

/**
 * Reuse the single ts worker monaco creates for `typescript` instead of spinning
 * up a second one. `getTypeScriptWorker()` rejects until monaco's lazy TS mode
 * setup has run, which only happens on `onLanguage('typescript')` — so poke that
 * with a throwaway model first (the same trick MonacoLoader uses for json).
 * `onLanguage` fires synchronously from createModel and monaco's setup chains off
 * the same `import('./tsMode.js')` promise, so its `.then` is queued ahead of
 * ours and the worker is registered by the time we await it.
 */
async function getSharedTypeScriptWorker(
  m: typeof monaco,
): Promise<(...uris: monaco.Uri[]) => Promise<unknown>> {
  m.editor.createModel('', 'typescript').dispose()
  return m.typescript.getTypeScriptWorker()
}

/**
 * Mirror `tsMode.setupMode`'s provider wiring for our own mode id. Only the
 * features MonacoLoader leaves on in `typescriptDefaults.modeConfiguration` get
 * registered, so this stays in step with whatever the loader disabled.
 */
async function registerWorkerFeatures(m: typeof monaco, logger: ILogger): Promise<void> {
  const [tsMode, worker] = await Promise.all([
    import('monaco-editor/esm/vs/language/typescript/tsMode.js'),
    getSharedTypeScriptWorker(m),
  ])
  const { modeConfiguration } = m.typescript.typescriptDefaults
  const enabled: string[] = []
  if (modeConfiguration.documentRangeFormattingEdits) {
    // Monaco's TS mode has no whole-document formatter; monaco derives
    // "Format Document" from the range provider.
    m.languages.registerDocumentRangeFormattingEditProvider(
      TSX_LANGUAGE_ID,
      new tsMode.FormatAdapter(worker),
    )
    enabled.push('documentRangeFormattingEdits')
  }
  if (modeConfiguration.onTypeFormattingEdits) {
    m.languages.registerOnTypeFormattingEditProvider(
      TSX_LANGUAGE_ID,
      new tsMode.FormatOnTypeAdapter(worker),
    )
    enabled.push('onTypeFormattingEdits')
  }
  if (modeConfiguration.documentHighlights) {
    m.languages.registerDocumentHighlightProvider(
      TSX_LANGUAGE_ID,
      new tsMode.DocumentHighlightAdapter(worker),
    )
    enabled.push('documentHighlights')
  }
  if (modeConfiguration.codeActions) {
    m.languages.registerCodeActionProvider(TSX_LANGUAGE_ID, new tsMode.CodeActionAdaptor(worker))
    enabled.push('codeActions')
  }
  if (modeConfiguration.inlayHints) {
    m.languages.registerInlayHintsProvider(TSX_LANGUAGE_ID, new tsMode.InlayHintsAdapter(worker))
    enabled.push('inlayHints')
  }
  logger.debug(`${TSX_LANGUAGE_ID}: ts-worker features registered [${enabled.join(', ')}]`)
}

/**
 * Register the language point plus its tokenizer/configuration. Called from
 * MonacoLoader right after monaco resolves, i.e. before TextMateService
 * initializes — so the TextMate grammar factory registers last and wins over the
 * Monarch fallback here, exactly like it does for `typescript`.
 *
 * Nothing is returned: monaco is a process-lifetime singleton with no teardown
 * (same as registerLogLanguage / registerMarkdownFrontmatterHighlight).
 */
export function registerTsxLanguage(m: typeof monaco, logger: ILogger = new NullLogger()): void {
  m.languages.register({
    id: TSX_LANGUAGE_ID,
    extensions: ['.tsx'],
    aliases: ['TypeScript JSX', 'TypeScript React', 'tsx'],
  })
  // Lazy, like monaco's own basic-languages contributions: the grammar module is
  // only fetched once a .tsx model is tokenized, and registering a *factory*
  // (rather than an eager provider) keeps TextMate's later registration the
  // unambiguous winner.
  m.languages.registerTokensProviderFactory(TSX_LANGUAGE_ID, {
    create: async () => {
      const ts = await import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js')
      return ts.language
    },
  })
  m.languages.onLanguage(TSX_LANGUAGE_ID, () => {
    void (async () => {
      try {
        const ts = await import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js')
        m.languages.setLanguageConfiguration(TSX_LANGUAGE_ID, ts.conf)
        await registerWorkerFeatures(m, logger)
      } catch (err: unknown) {
        // Coloring and the LSP features are unaffected; only bracket/comment
        // behaviour and the built-in worker extras would be missing.
        logger.error(`${TSX_LANGUAGE_ID}: monaco language setup failed`, err)
      }
    })()
  })
}
