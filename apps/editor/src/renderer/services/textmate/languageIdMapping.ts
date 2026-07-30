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
 *--------------------------------------------------------------------------------------------*/

/** VSCode language id → monaco language id, for the ids that differ. */
const VSCODE_TO_MONACO_LANGUAGE_ID: Readonly<Record<string, string>> = {
  typescriptreact: 'typescript',
  javascriptreact: 'javascript',
  jsonc: 'json',
  jsonl: 'json',
  shellscript: 'shell',
}

/** Map a manifest language id onto the monaco language registry's id space. */
export function toMonacoLanguageId(languageId: string): string {
  return VSCODE_TO_MONACO_LANGUAGE_ID[languageId] ?? languageId
}
