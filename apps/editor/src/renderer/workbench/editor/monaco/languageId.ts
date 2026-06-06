/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Normalizes a markdown code-fence language tag to a registered Monaco
 *  languageId. Monaco's `colorize` silently falls back to unhighlighted text
 *  when the languageId isn't registered, and fence tags are usually aliases
 *  (`js`, `py`, `sh`, `c++`) rather than canonical ids — so we resolve them via
 *  Monaco's own id/alias/extension tables, with a small extra table for the
 *  handful of common spellings Monaco doesn't carry.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from './MonacoLoader.js'

interface LanguageTables {
  ids: Set<string>
  aliasToId: Map<string, string>
  extToId: Map<string, string>
}

let _tables: LanguageTables | undefined

// Spellings Monaco carries neither as an alias nor as a file extension.
const EXTRA_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  cplusplus: 'cpp',
  golang: 'go',
  bash: 'shell',
  zsh: 'shell',
  sh: 'shell',
}

function buildTables(monacoNs: typeof monaco): LanguageTables {
  const ids = new Set<string>()
  const aliasToId = new Map<string, string>()
  const extToId = new Map<string, string>()
  for (const lang of monacoNs.languages.getLanguages()) {
    ids.add(lang.id)
    aliasToId.set(lang.id.toLowerCase(), lang.id)
    for (const alias of lang.aliases ?? []) {
      if (alias) aliasToId.set(alias.toLowerCase(), lang.id)
    }
    for (const ext of lang.extensions ?? []) {
      if (ext) extToId.set(ext.toLowerCase(), lang.id)
    }
  }
  return { ids, aliasToId, extToId }
}

/**
 * Resolve a fence language tag to a registered Monaco languageId, or undefined
 * when no language matches (caller should then render plain text).
 */
export function resolveLanguageId(lang: string, monacoNs: typeof monaco): string | undefined {
  const tag = lang.trim().toLowerCase()
  if (tag === '') return undefined
  if (!_tables) _tables = buildTables(monacoNs)
  const { ids, aliasToId, extToId } = _tables
  if (ids.has(lang)) return lang
  const byAlias = aliasToId.get(tag)
  if (byAlias) return byAlias
  const byExt = extToId.get(`.${tag}`)
  if (byExt) return byExt
  return EXTRA_ALIASES[tag]
}

export function _resetForTests(): void {
  _tables = undefined
}
