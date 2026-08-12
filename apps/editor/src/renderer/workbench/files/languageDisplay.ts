/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Language display-name resolution: Monaco's `aliases[0]` is the user-facing
 *  name for most languages; a hand-maintained override table covers the
 *  grammar-only languages (registered by the textmate-grammars extension)
 *  whose ids have no friendly alias.
 *--------------------------------------------------------------------------------------------*/

import { MonacoLoader } from '../editor/monaco/MonacoLoader.js'

// Ids with no Monaco alias (grammar-only registrations) or an unfriendly one.
// Wins over aliases. The all-caps entries below duplicate Monaco's own aliases
// so the pre-Monaco fallback (status bar during startup) shows them correctly.
const OVERRIDES: Record<string, string> = {
  plaintext: 'Plain Text',
  dotenv: 'Dotenv',
  ignore: 'Ignore',
  makefile: 'Makefile',
  diff: 'Diff',
  // The entries below duplicate Monaco's own aliases so the pre-Monaco
  // fallback (status bar during startup) matches what the picker shows.
  json: 'JSON',
  markdown: 'Markdown',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  html: 'HTML',
  css: 'CSS',
  xml: 'XML',
  yaml: 'YAML',
}

export function displayNameFromAliases(id: string, aliases?: readonly string[]): string {
  const override = OVERRIDES[id]
  if (override) return override
  const alias = aliases?.[0]
  if (alias) return alias
  return id.charAt(0).toUpperCase() + id.slice(1)
}

// Grammar-only languages register after the first build, but they carry no
// aliases, so for them a stale cache is indistinguishable from a fresh one.
// Never cached while Monaco isn't ready (get() throws and we stay uncached).
let aliasCache: Map<string, readonly string[] | undefined> | undefined

export function languageDisplayName(id: string): string {
  try {
    if (!aliasCache) {
      aliasCache = new Map()
      for (const language of MonacoLoader.get().languages.getLanguages()) {
        aliasCache.set(language.id, language.aliases)
      }
    }
    return displayNameFromAliases(id, aliasCache.get(id))
  } catch {
    return displayNameFromAliases(id)
  }
}
