/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Grammar manifests use VSCode language ids (typescriptreact, shellscript,
 *  jsonc, …) while this editor's whole language chain (Monaco basic-languages,
 *  resourceLanguage, the typescript LSP plugin) is built on monaco's language
 *  ids. The TextMate machinery therefore maps ids at its boundary: registration
 *  (which monaco language a grammar factory binds to) and metadata encoding
 *  (embedded language ids). Ids absent from monaco's registry encode to
 *  LanguageId.Null — harmless, the token still gets its color.
 *
 *  Only map an id here when the target monaco language's grammar is a superset:
 *  several manifest ids collapsing onto one monaco id means the *first* grammar
 *  in extension order wins and the rest are dropped (see
 *  `TextMateService._rebuildRegistrations`). `jsonc`/`jsonl` are fine (json's
 *  grammar covers them) and so is `javascriptreact` (source.js handles JSX),
 *  but `typescriptreact` must NOT collapse onto `typescript`: source.ts has no
 *  JSX rules, so `.tsx` would lose its tag colors entirely.
 *--------------------------------------------------------------------------------------------*/

/** VSCode language id → monaco language id, for the ids that differ. */
const VSCODE_TO_MONACO_LANGUAGE_ID: Readonly<Record<string, string>> = {
  javascriptreact: 'javascript',
  jsonc: 'json',
  jsonl: 'json',
  shellscript: 'shell',
}

/** Map a manifest language id onto the monaco language registry's id space. */
export function toMonacoLanguageId(languageId: string): string {
  return VSCODE_TO_MONACO_LANGUAGE_ID[languageId] ?? languageId
}
